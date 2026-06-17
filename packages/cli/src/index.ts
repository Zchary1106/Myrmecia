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
import * as readline from 'node:readline';

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
    model: { type: 'string', short: 'm' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
    'no-stream': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

let SERVER = String(flags.server || process.env.MYRMECIA_SERVER || process.env.AGENT_FACTORY_URL || 'http://localhost:3000').replace(/\/+$/, '');
let TOKEN = String(flags.token || process.env.MYRMECIA_TOKEN || process.env.AGENT_FACTORY_TOKEN || '');
const JSON_OUT = Boolean(flags.json);
const NO_STREAM = Boolean(flags['no-stream']);
let INTERACTIVE = false;
let currentModel = String(flags.model || process.env.MYRMECIA_MODEL || 'auto');
let agentCount = 0;
let connected = false;

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

const out = (s = '') => {
  if (footerActive) { footerPrintAbove(s); return; }
  process.stdout.write(s + '\n');
};
const die = (msg: string, code = 1): never => { process.stderr.write(c.red('error: ') + msg + '\n'); process.exit(code); };

// 24-bit truecolor (falls back to plain when color is disabled).
const rgb = (r: number, g: number, b: number) => (s: string) => (useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : s);

// teal → cyan → violet gradient (one stop per banner letter).
const GRAD: ReadonlyArray<readonly [number, number, number]> = [
  [57, 210, 192], [66, 197, 210], [75, 185, 228], [84, 172, 246],
  [102, 162, 255], [131, 155, 255], [159, 147, 255], [188, 140, 255],
];

// ANSI-shadow glyphs for the wordmark (6 rows each).
const GLYPHS: Record<string, string[]> = {
  M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
  Y: ['██╗   ██╗', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚██╔╝  ', '   ██║   ', '   ╚═╝   '],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
};

function renderBanner(): string {
  const word = 'MYRMECIA';
  const cols = process.stdout.columns || 80;
  // Big banner only when it fits; otherwise a compact gradient wordmark.
  const fullWidth = [...word].reduce((w, ch) => w + (GLYPHS[ch]?.[0].length || 0) + 1, 0);
  if (cols < fullWidth + 2) {
    const compact = [...word].map((ch, i) => rgb(...GRAD[i % GRAD.length])(ch)).join(' ');
    return `  ${c.bold(compact)}`;
  }
  const rows = ['', '', '', '', '', ''];
  [...word].forEach((ch, i) => {
    const g = GLYPHS[ch];
    const paint = rgb(...GRAD[i % GRAD.length]);
    for (let r = 0; r < 6; r++) rows[r] += paint(g[r]) + ' ';
  });
  return rows.map(r => ' ' + r).join('\n');
}

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
    if (INTERACTIVE) throw new Error(`cannot reach server at ${SERVER} (${e?.message || e})`);
    return die(`cannot reach server at ${SERVER} (${e?.message || e}). Is it running? Try --server <url>.`);
  }
  const text = await res.text();
  let data: any = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const m = data?.error?.message || data?.message || (typeof data === 'string' ? data : res.statusText);
    if (INTERACTIVE) throw new Error(`${res.status} ${path} — ${m}`);
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

// --------------------------------------------------------------------- teams
// Canonical roster lives in agents/teams.yaml; embedded here so the CLI stays
// dependency-free. Each team maps to an existing pipeline template by name.
interface Team { id: string; name: string; emoji: string; lead: string; members: string[]; template: string; triggers: string[]; blurb: string; }
const TEAMS: Team[] = [
  { id: 'feature', name: 'Feature Team', emoji: '🛠️', lead: 'master',
    members: ['product-manager', 'designer', 'developer', 'tester', 'devops'],
    template: 'Full Product', triggers: ['feature', 'build', 'add', 'implement', 'ship', 'product'],
    blurb: 'Ship a feature end-to-end — spec, design, code, test, deploy.' },
  { id: 'bugfix', name: 'Bugfix Team', emoji: '🐛', lead: 'master',
    members: ['product-manager', 'developer', 'tester'],
    template: 'Bugfix', triggers: ['bug', 'fix', 'broken', 'error', 'crash', 'regression', 'hotfix'],
    blurb: 'Triage, fix, and verify a defect fast.' },
  { id: 'quality', name: 'Quality Team', emoji: '🔍', lead: 'master',
    members: ['accessibility-tester', 'react-dashboard-auditor', 'performance-investigator', 'release-notes'],
    template: 'Product Quality', triggers: ['audit', 'accessibility', 'performance', 'quality', 'a11y', 'lighthouse'],
    blurb: 'Audit accessibility, UI, and performance, then summarize.' },
  { id: 'release', name: 'Release & Security Team', emoji: '🔒', lead: 'master',
    members: ['issue-refiner', 'qa-automation', 'security-reviewer', 'gitops', 'release-compliance'],
    template: 'Release Compliance', triggers: ['release', 'security', 'compliance', 'gate', 'vulnerability'],
    blurb: 'Refine, test, security-audit, and gate a release.' },
  { id: 'content', name: 'Content Team', emoji: '✍️', lead: 'master',
    members: ['product-manager', 'content-writer', 'reviewer'],
    template: 'WeChat Article', triggers: ['article', 'post', 'blog', 'write', '公众号', '文章', 'content'],
    blurb: 'Plan, write, and review long-form content.' },
];
const findTeam = (id: string): Team | undefined =>
  TEAMS.find(t => t.id === (id || '').toLowerCase().replace(/^@/, ''));

/** Suggest a team for a plain-language task from trigger keywords. */
function suggestTeam(input: string): Team | undefined {
  const low = input.toLowerCase();
  let best: Team | undefined; let bestScore = 0;
  for (const t of TEAMS) {
    const score = t.triggers.reduce((n, kw) => n + (low.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore > 0 ? best : undefined;
}

function cmdTeams() {
  if (JSON_OUT) return out(JSON.stringify(TEAMS, null, 2));
  out(c.bold(`Teams (${TEAMS.length})`) + c.gray('   —  squads of specialists with a lead'));
  out('');
  for (const t of TEAMS) {
    out(`  ${t.emoji}  ${c.bold(t.name)} ${c.gray('· @' + t.id)}`);
    out(`     ${c.gray(t.blurb)}`);
    out(`     ${c.dim('lead ')}${c.cyan(t.lead)}${c.dim('  ·  ')}${t.members.map(m => c.cyan(m)).join(c.dim(' → '))}`);
    out('');
  }
  out(c.gray('  Put a team to work: ') + c.cyan('@' + TEAMS[0].id + ' <task>') + c.gray('   (e.g. ') + c.cyan('@feature add a dark-mode toggle') + c.gray(')'));
}

/** Dispatch a task to a team: runs the team's pipeline template as a live board. */
async function runTeam(team: Team, input: string) {
  if (!input) { out(c.red('usage: ') + c.cyan('@' + team.id + ' <task>')); return; }
  footerMount(`${team.name} · assembling`);
  try {
    const tpls = listOf(await api('/templates'));
    const tpl = tpls.find((t: any) => (t.name || '').toLowerCase() === team.template.toLowerCase());
    if (!tpl) { out(c.red(`team template not found: ${team.template}`)); return; }

    out(`${team.emoji}  ${c.bold(team.name)} ${c.gray('· lead ')}${c.cyan(team.lead)} ${c.gray('· ' + team.members.length + ' teammates')}`);
    const gateMode = (flags.gate === 'manual' ? 'manual' : 'auto');
    const created = one(await api('/pipelines', { method: 'POST', body: { name: `${team.name}: ${input.slice(0, 40)}`, templateId: tpl.id, input, gateMode } }));
    const pid = created.id;

    // Live team board — print each teammate's status as it changes.
    const printed = new Map<string, string>();
    let p: any;
    for (;;) {
      p = one(await api(`/pipelines/${pid}`));
      let active: any;
      for (const s of p.stages || []) {
        const st = String(s.status || '').toLowerCase();
        if (['running', 'assigned', 'pending'].includes(st) && !active) active = s;
        if (printed.get(s.name) !== s.status) {
          printed.set(s.name, s.status);
          const mark = st === 'done' || st === 'completed' ? c.green('✓')
            : st === 'failed' ? c.red('✗')
            : st === 'running' ? c.yellow('▸') : c.gray('·');
          out(`  ${mark} ${String(s.name).padEnd(14)} ${c.gray(s.agentRole || '')}`);
        }
      }
      footerSet(active ? `${team.name} · ${active.name} (${active.agentRole || '…'})` : `${team.name} · working`);
      const pst = (p.status || '').toLowerCase();
      if (['completed', 'failed', 'cancelled', 'blocked'].includes(pst)) break;
      await sleep(2500);
    }
    out('');
    out(`${c.bold(team.name)} ${statusColor(p.status)}`);
    const last = (p.stages || []).filter((s: any) => s.output).slice(-1)[0];
    if (last?.output) { out(c.gray(`  ── ${last.name} ──`)); out(indent(String(last.output).slice(0, 1400))); }
    if (['failed', 'blocked'].includes((p.status || '').toLowerCase())) process.exitCode = 1;
  } finally {
    footerUnmount();
  }
}

const indent = (s: string, pad = '    ') => s.split('\n').map(l => pad + l).join('\n');

let cursorHidden = false;
const showCursor = () => { if (cursorHidden) { process.stdout.write('\x1b[?25h'); cursorHidden = false; } };
process.on('exit', showCursor);

/**
 * A single-line braille spinner. Returns a stop() that clears the line.
 * Falls back to a one-shot printed label when stdout isn't an interactive TTY.
 */
function startSpinner(label: string): () => void {
  if (!process.stdout.isTTY || !useColor) {
    out(c.gray(`  ${label}…`));
    return () => {};
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  cursorHidden = true;
  process.stdout.write('\x1b[?25l');
  const tick = () => {
    process.stdout.write('\r  ' + rgb(57, 210, 192)(frames[i % frames.length]) + ' ' + c.gray(label) + '\x1b[K');
    i++;
  };
  tick();
  const iv = setInterval(tick, 80);
  return () => { clearInterval(iv); process.stdout.write('\r\x1b[K'); showCursor(); };
}

/** Stream a task's live events until it reaches a terminal state. Agent-text
 *  snippets are shown as an ephemeral live preview (footer) — never committed
 *  to scrollback — so the caller can print the full authoritative output once. */
async function streamTask(taskId: string): Promise<any> {
  let finished = false;
  const useFooter = footerActive;
  let spinnerStop: (() => void) | null = useFooter ? null : startSpinner('agent working');
  const stopSpinner = () => { if (spinnerStop) { spinnerStop(); spinnerStop = null; } };
  if (useFooter) footerSet('agent working');
  const printEvent = (ev: any) => {
    const p = ev.payload || {};
    if (p.taskId && p.taskId !== taskId) return;
    if (ev.type === 'execution:message' && p.content) {
      // Live preview only (snippets are truncated server-side) — keep them in
      // the footer so the full output isn't duplicated/truncated in scrollback.
      const preview = String(p.content).replace(/\s+/g, ' ').trim().slice(0, 72);
      if (useFooter && preview) footerSet(preview);
    } else if (ev.type === 'tool:started' || ev.type === 'tool:start') {
      const tool = p.toolId || p.toolName || 'tool';
      if (useFooter) footerSet(`running ${tool}`);
      else stopSpinner();
      out(c.magenta(`  🔧 ${tool}`));
    }
  };
  const stream = streamChannel(`task:${taskId}`, printEvent, (ev) => {
    const p = ev.payload || {};
    return ['task:done', 'task:failed', 'task:cancelled'].includes(ev.type) && p.taskId === taskId;
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
  stopSpinner();
  return one(await api(`/tasks/${taskId}`));
}

async function cmdRun(agentId: string, promptParts: string[]) {
  const prompt = promptParts.join(' ').trim();
  if (!agentId || !prompt) return die('usage: myrmecia run <agentId> <prompt...>');
  const res = await api(`/agents/${agentId}/execute`, { method: 'POST', body: { prompt } });
  const taskId = res.taskId || one(res)?.taskId;
  if (!taskId) return die('server did not return a taskId');
  if (JSON_OUT) return out(JSON.stringify({ taskId }, null, 2));
  out(`${c.green('▶')} ${c.bold(agentId)} task ${c.cyan(taskId)}`);
  if (NO_STREAM) { out(c.dim('queued (use `myrmecia task ' + taskId + '` to check)')); return; }
  const t = await streamTask(taskId);
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

// ------------------------------------------------------------ model switching
const ROUTE_KEYS_TO_FORCE = [
  'global', 'task:simple', 'task:coding', 'task:long-context', 'task:high-risk',
  'role:orchestrator', 'role:product-manager', 'role:designer', 'role:developer',
  'role:tester', 'role:reviewer',
];

async function initCurrentModel() {
  if (currentModel && currentModel !== 'auto') return;
  try {
    const routes = listOf(await api('/models/routes'));
    const global = routes.find((r: any) => r.routeKey === 'global');
    if (global?.defaultModelId) currentModel = global.defaultModelId;
  } catch { /* leave as 'auto' */ }
}

/** Force the whole colony onto one model by repointing the core routes. */
async function setModel(id: string, quiet = false) {
  const models = listOf(await api('/models'));
  const m = models.find((x: any) => x.id === id);
  if (!m) {
    out(c.red(`unknown model: ${id}`));
    out(c.gray('  available: ') + models.map((x: any) => x.id).slice(0, 12).join(', ') + (models.length > 12 ? ' …' : ''));
    return;
  }
  const tier = m.tier || 'balanced';
  const group = m.fallbackGroup || 'balanced';
  for (const routeKey of ROUTE_KEYS_TO_FORCE) {
    try {
      await api('/models/routes', { method: 'PATCH', body: { routeKey, defaultModelId: id, modelTier: tier, fallbackGroup: group } });
    } catch { /* best effort per route */ }
  }
  currentModel = id;
  if (!quiet) out(c.green('✓') + c.gray(' model → ') + c.cyan(id) + c.gray(`  (${tier}, applied to the colony)`));
}

/**
 * Split a raw-mode stdin chunk into individual key tokens. A single read can
 * bundle several keystrokes (e.g. a pasted line, or "↓↓⏎" arriving at once),
 * so we slice escape sequences (CSI "\x1b[…", SS3 "\x1bO…") as whole tokens and
 * emit every other byte on its own.
 */
function parseKeys(d: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < d.length) {
    if (d[i] === '\u001b' && (d[i + 1] === '[' || d[i + 1] === 'O')) {
      let j = i + 2;
      while (j < d.length && !/[A-Za-z~]/.test(d[j])) j++;
      keys.push(d.slice(i, j + 1));
      i = j + 1;
    } else {
      keys.push(d[i]);
      i += 1;
    }
  }
  return keys;
}

/**
 * Interactive raw-mode model picker (↑/↓ to move, Enter to select, Esc to
 * cancel). Returns the chosen model id, or null if cancelled. TTY only.
 */
function pickModel(models: any[], current: string): Promise<string | null> {
  return new Promise((resolve) => {
    const items = models.filter((m) => m.enabled !== false);
    if (items.length === 0) return resolve(null);
    let idx = items.findIndex((m) => m.id === current);
    if (idx < 0) idx = 0;
    const stdin = process.stdin as any;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const teal = rgb(57, 210, 192);
    const H = items.length + 1;
    let drawn = false;

    const render = () => {
      const lines: string[] = [];
      lines.push(c.gray('  select a model  ') + c.dim('↑/↓ move · enter select · esc cancel'));
      for (let i = 0; i < items.length; i++) {
        const m = items[i];
        const dot = m.id === current ? c.green('●') : c.gray('○');
        const id = (m.id || '').padEnd(26);
        const tier = c.gray((m.tier || '').padEnd(9));
        lines.push(i === idx
          ? '  ' + teal('❯ ') + dot + ' ' + c.bold(id) + ' ' + tier
          : '    ' + dot + ' ' + c.gray(id) + ' ' + tier);
      }
      if (drawn) process.stdout.write(`\x1b[${H}A`); else drawn = true;
      process.stdout.write('\r\x1b[J' + lines.join('\n') + '\n');
    };

    const cleanup = () => {
      if (drawn) process.stdout.write(`\x1b[${H}A\r\x1b[J`);
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const onData = (chunk: string) => {
      for (const d of parseKeys(chunk)) {
        if (d === '\u0003' || d === '\u001b' || d === 'q') { cleanup(); return resolve(null); } // Ctrl+C / Esc / q
        if (d === '\r' || d === '\n') { cleanup(); return resolve(items[idx].id); }
        if (d === '\u001b[A' || d === '\u001bOA' || d === 'k') { idx = (idx - 1 + items.length) % items.length; render(); continue; }
        if (d === '\u001b[B' || d === '\u001bOB' || d === 'j') { idx = (idx + 1) % items.length; render(); continue; }
      }
    };

    stdin.on('data', onData);
    render();
  });
}

async function cmdModelSwitch(arg?: string) {
  if (arg) return setModel(arg);
  const models = listOf(await api('/models'));

  // In a real terminal, offer an interactive picker; otherwise print a list.
  if (process.stdin.isTTY && INTERACTIVE) {
    out(c.bold('Models') + c.gray('   current: ') + c.cyan(currentModel));
    const chosen = await pickModel(models, currentModel);
    if (!chosen) { out(c.gray('  (unchanged)')); return; }
    if (chosen === currentModel) { out(c.gray('  already on ') + c.cyan(chosen)); return; }
    return setModel(chosen);
  }

  out(c.bold('Models') + c.gray(`   (current: `) + c.cyan(currentModel) + c.gray(')'));
  for (const m of models) {
    const on = m.enabled === false ? c.red('off') : c.green('on');
    const mark = m.id === currentModel ? c.green(' ●') : '  ';
    out(`${mark} ${(m.id || '').padEnd(28)} ${c.gray((m.tier || '').padEnd(10))} ${on}`);
  }
  out(c.gray('  switch with ') + c.cyan('/model <id>'));
}

// --------------------------------------------------------------- interactive
async function quietHealth(): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2000);
    const headers: Record<string, string> = {};
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const r = await fetch(`${SERVER}/api/v1/health`, { headers, signal: ctrl.signal });
    clearTimeout(to);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function welcome() {
  out('');
  out(renderBanner());
  out('');
  out('  ' + c.bold('Autonomous Multi-Agent Orchestration') + c.gray('   ·   v0.1'));
  out('  ' + c.gray('Not one model — a ') + c.cyan('colony') + c.gray('. Describe a task; the right specialists are routed, run in'));
  out('  ' + c.gray('parallel when useful, and remembered. You stay in control of the whole hive.'));
  out('');
  const h = await quietHealth();
  if (h) {
    connected = true;
    agentCount = Number(h.agents?.total ?? 0) || 0;
    out('  ' + c.green('●') + ' ' + c.gray('connected ') + c.cyan(SERVER)
      + c.gray(`   ·   ${h.agents?.total ?? '?'} agents ready   ·   model `) + rgb(57, 210, 192)(currentModel));
  } else {
    connected = false;
    out('  ' + c.red('●') + ' ' + c.gray('offline — start the server with ') + c.cyan('pnpm dev') + c.gray(' (or pass --server)'));
  }
  out('  ' + c.gray(`${TEAMS.length} teams ready — `) + TEAMS.map(t => t.emoji + ' ' + c.cyan('@' + t.id)).join(c.gray('  '))) ;
  out('  ' + c.gray('Type a task, or ') + c.cyan('/teams') + c.gray(' · ')
    + c.cyan('/agents') + c.gray(' · ') + c.cyan('/model') + c.gray(' · ') + c.cyan('/help') + c.gray(' · ') + c.cyan('/exit'));
  out('');
}

async function cmdPipelinesList() {
  const ps = listOf(await api('/pipelines'));
  out(c.bold(`Pipelines (${ps.length})`));
  for (const p of ps.slice(0, 15)) {
    out(`  ${statusColor(String(p.status || '').padEnd(10))} ${c.cyan(p.id)} ${c.gray(p.name || '')}`);
  }
}

function slashHelp() {
  out(c.bold('Slash commands'));
  const rows: Array<[string, string]> = [
    ['/teams', 'list agent teams (squads)'],
    ['@team <task>', 'put a team to work (e.g. @feature …)'],
    ['/agents', 'list the agent colony'],
    ['/model [id]', 'show models / switch the active model'],
    ['/models', 'list models + routing status'],
    ['/templates', 'list pipeline templates'],
    ['/pipelines', 'recent pipeline runs'],
    ['/health', 'server status'],
    ['/server [url]', 'show or switch the target server'],
    ['/clear', 'clear the screen'],
    ['/help', 'this help'],
    ['/exit', 'quit'],
  ];
  for (const [k, v] of rows) out(`  ${c.cyan(k.padEnd(16))} ${c.gray(v)}`);
  out('');
  out(c.gray('  Or just type a task in plain language — the colony routes it to a specialist.'));
}

async function handleSlash(input: string): Promise<boolean> {
  const [cmd, ...rest] = input.slice(1).trim().split(/\s+/);
  switch ((cmd || '').toLowerCase()) {
    case 'help': case '?': slashHelp(); break;
    case 'teams': case 'team': cmdTeams(); break;
    case 'agents': case 'agent': await cmdAgents(); break;
    case 'models': await cmdModels(); break;
    case 'model': case 'm': await cmdModelSwitch(rest[0]); break;
    case 'templates': case 'template': await cmdTemplates(); break;
    case 'pipelines': case 'pipeline': await cmdPipelinesList(); break;
    case 'health': case 'status': await cmdHealth(); break;
    case 'banner': out(renderBanner()); break;
    case 'server':
      if (rest[0]) { SERVER = rest[0].replace(/\/+$/, ''); out(c.gray('server → ') + c.cyan(SERVER)); }
      else out(c.gray('server: ') + c.cyan(SERVER));
      break;
    case 'clear': case 'cls': process.stdout.write('\x1b[2J\x1b[H'); break;
    case 'exit': case 'quit': case 'q': return false;
    default: out(c.red(`unknown command: /${cmd}`) + c.gray('  (try /help)'));
  }
  return true;
}

/** Natural-language input → classify + dispatch via the supervisor → stream the result. */
async function dispatchInteractive(input: string) {
  footerMount('routing to a specialist');
  try {
    const res = one(await api('/supervisor/dispatch', { method: 'POST', body: { input } }));
    const intent = res?.intent || {};
    const agent = intent.suggestedAgent || '—';
    const mode = res?.mode || intent.suggestedMode || '—';
    const complexity = intent.complexity || '—';
    const via = intent.routingSource || 'classifier';
    out(`${c.cyan('🐜 routed')} → ${c.bold(agent)} ${c.gray(`· ${mode} · ${complexity} · via ${via}`)}`);
    const tasks = res?.tasks || [];
    if (tasks.length > 1) out(c.gray(`  decomposed into ${tasks.length} tasks — streaming the first`));
    if (tasks.length) {
      const task = await streamTask(tasks[0].id);
      out('');
      out(`${c.bold('result')} ${statusColor(task.status)}`);
      if (task.output) out(indent(String(task.output)));
    } else if (res?.orchestration?.result) {
      out(indent(String(res.orchestration.result)));
    } else {
      out(c.gray('  (dispatched)'));
    }
    const tip = suggestTeam(input);
    if (tip) out(c.dim(`  tip: this looks like a job for `) + c.cyan('@' + tip.id) + c.dim(` — try `) + c.cyan(`@${tip.id} ${input.slice(0, 32)}${input.length > 32 ? '…' : ''}`));
  } finally {
    footerUnmount();
  }
}

// ----------------------------------------------------------- boxed TUI input
/** Build a line of exactly `totalW` visible columns; the segment at `fillIndex` flexes. */
function boxLine(segs: Array<[string, (s: string) => string]>, totalW: number, fillIndex: number, fillChar = ' '): string {
  const fixed = segs.reduce((n, [t], i) => (i === fillIndex ? n : n + t.length), 0);
  const fillLen = Math.max(0, totalW - fixed);
  return segs.map(([t, fn], i) => (i === fillIndex ? fn(fillChar.repeat(fillLen)) : fn(t))).join('');
}

/**
 * Build the 5-line input frame (meta · rule · body · rule · hints) for a given
 * width. `body` is either the editable input (text + cursorOffset) or a busy
 * status string. Shared by the editable box and the pinned busy footer.
 */
function buildInputFrame(w: number, opts: { text?: string; busy?: string; cursorOffset?: number }): { lines: string[]; cursorCol: number } {
  const teal = rgb(57, 210, 192);
  const PREFIX = '  › ';
  const host = SERVER.replace(/^https?:\/\//, '');
  const rightTop = connected ? `${host}  ·  ${agentCount} agents` : `${host}  ·  offline`;
  const dotColor = connected ? c.green : c.red;
  const metaTop = boxLine([
    ['  ', c.gray], ['● ', () => dotColor('●') + ' '], ['myrmecia', c.cyan], ['', c.gray], [rightTop, c.gray], ['  ', c.gray],
  ], w, 3, ' ');
  const rule = c.gray('  ' + '─'.repeat(Math.max(0, w - 4)) + '  ');

  let inputLine: string;
  let cursorCol = PREFIX.length + 1;
  if (opts.busy !== undefined) {
    inputLine = c.cyan(PREFIX) + opts.busy;
  } else {
    inputLine = c.cyan(PREFIX) + (opts.text || '');
    cursorCol = PREFIX.length + 1 + (opts.cursorOffset || 0);
  }

  const hintsPlain = '/help · /model · /agents · /exit';
  const hintsColored = hintsPlain.split(' · ').map((h) => c.cyan(h)).join(c.gray(' · '));
  const metaBot = boxLine([
    ['  ', c.gray], [hintsPlain, () => hintsColored], ['', c.gray],
    [`model ${currentModel}`, () => c.gray('model ') + teal(currentModel)], ['  ', c.gray],
  ], w, 2, ' ');

  return { lines: [metaTop, rule, inputLine, rule, metaBot], cursorCol };
}

// ---- pinned bottom frame: keeps the input frame visible while output scrolls above it
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FOOTER_H = 5;
let footerActive = false;
let footerStatus = '';
let footerSpinIdx = 0;
let footerTimer: ReturnType<typeof setInterval> | null = null;
const footerWidth = () => Math.max(48, (process.stdout.columns || 80) - 1);

function footerBody(): string {
  const teal = rgb(57, 210, 192);
  if (!footerStatus) return c.dim('working…');
  return teal(SPIN[footerSpinIdx % SPIN.length]) + ' ' + c.gray(footerStatus) + c.dim('   ·  esc to interrupt');
}
function footerDraw() {
  const { lines } = buildInputFrame(footerWidth(), { busy: footerBody() });
  process.stdout.write(lines.join('\n'));
}
function footerErase() {
  process.stdout.write(`\r\x1b[${FOOTER_H - 1}A\x1b[J`);
}
function footerMount(status: string) {
  if (!process.stdout.isTTY || !useColor) { out(c.gray(`  ${status}…`)); return; }
  footerStatus = status; footerActive = true; footerSpinIdx = 0;
  process.stdout.write('\x1b[?25l'); cursorHidden = true;
  footerDraw();
  footerTimer = setInterval(() => { footerSpinIdx++; footerErase(); footerDraw(); }, 90);
}
function footerSet(status: string) {
  footerStatus = status;
  if (footerActive) { footerErase(); footerDraw(); }
}
function footerUnmount() {
  if (!footerActive) return;
  if (footerTimer) { clearInterval(footerTimer); footerTimer = null; }
  footerErase();
  footerActive = false;
  showCursor();
}
function footerPrintAbove(text: string) {
  footerErase();
  process.stdout.write(text + '\n');
  footerDraw();
}

/**
 * A Copilot-CLI-style input frame (raw mode): a slim meta line, a full-width
 * horizontal rule, the `›` input line, a closing rule, and a hints line — no
 * vertical side bars. Redraws on each keystroke. Resolves with the submitted
 * line, or null on Ctrl+C / Ctrl+D-on-empty. TTY only.
 */
function readBoxedLine(history: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin as any;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    let cur = 0;
    let hi = history.length;
    let saved = '';
    let drawn = false;

    const INPUT_ROW = 2;            // 0:meta-top 1:rule 2:input 3:rule 4:meta-bottom
    const width = () => Math.max(48, (process.stdout.columns || 80) - 1);

    const frame = () => {
      const w = width();
      const inputW = w - 6;
      let start = 0;
      if (buf.length > inputW) start = Math.max(0, Math.min(cur, buf.length - inputW));
      if (cur - start > inputW) start = cur - inputW;
      if (cur < start) start = cur;
      const visible = buf.slice(start, start + inputW);
      const cursorOffset = buf.length === 0 ? 0 : cur - start;
      const text = buf.length === 0 ? c.dim('Describe a task, or /help') : c.bold(visible);
      return buildInputFrame(w, { text, cursorOffset });
    };

    const draw = () => {
      const { lines, cursorCol } = frame();
      if (drawn) process.stdout.write(`\x1b[${INPUT_ROW}A\r\x1b[J`); else drawn = true;
      process.stdout.write(lines.join('\n'));
      process.stdout.write(`\x1b[${lines.length - 1 - INPUT_ROW}A` + `\x1b[${cursorCol}G`);
    };

    const cleanup = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.removeListener('resize', onResize); };
    const commit = (val: string | null) => {
      if (drawn) process.stdout.write(`\x1b[${INPUT_ROW}A\r\x1b[J`);
      cleanup();
      if (val && val.trim()) process.stdout.write(c.cyan('❯ ') + val + '\n');
      resolve(val);
    };
    const onResize = () => { if (drawn) draw(); };
    process.stdout.on('resize', onResize);

    const onData = (chunk: string) => {
      let changed = false;
      for (const d of parseKeys(chunk)) {
        if (d === '\u0003') { process.stdout.write('\n'); return commit(null); }       // Ctrl+C
        if (d === '\u0004') { if (!buf) { process.stdout.write('\n'); return commit(null); } continue; } // Ctrl+D
        if (d === '\r' || d === '\n') return commit(buf);                               // Enter
        if (d === '\u0015') { buf = buf.slice(cur); cur = 0; changed = true; continue; }      // Ctrl+U
        if (d === '\u0001') { cur = 0; changed = true; continue; }                            // Ctrl+A
        if (d === '\u0005') { cur = buf.length; changed = true; continue; }                   // Ctrl+E
        if (d === '\u007f' || d === '\b') { if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; changed = true; } continue; }
        if (d.startsWith('\u001b')) {
          if (d === '\u001b[D' || d === '\u001bOD') { if (cur > 0) { cur--; changed = true; } continue; }
          if (d === '\u001b[C' || d === '\u001bOC') { if (cur < buf.length) { cur++; changed = true; } continue; }
          if (d === '\u001b[H' || d === '\u001bOH' || d === '\u001b[1~') { cur = 0; changed = true; continue; }
          if (d === '\u001b[F' || d === '\u001bOF' || d === '\u001b[4~') { cur = buf.length; changed = true; continue; }
          if (d === '\u001b[A' || d === '\u001bOA') { if (hi > 0) { if (hi === history.length) saved = buf; hi--; buf = history[hi]; cur = buf.length; changed = true; } continue; }
          if (d === '\u001b[B' || d === '\u001bOB') { if (hi < history.length) { hi++; buf = hi === history.length ? saved : history[hi]; cur = buf.length; changed = true; } continue; }
          continue;
        }
        const text = d.replace(/[\u0000-\u001f\u007f]/g, '');
        if (text) { buf = buf.slice(0, cur) + text + buf.slice(cur); cur += text.length; changed = true; }
      }
      if (changed) draw();
    };

    stdin.on('data', onData);
    draw();
  });
}

async function cmdChat() {
  INTERACTIVE = true;
  await initCurrentModel();
  if (flags.model) await setModel(String(flags.model), true).catch(() => {});
  await welcome();
  const history: string[] = [];
  const handle = async (input: string): Promise<boolean> => {
    if (!input) return true;
    try {
      if (input.startsWith('/')) {
        if ((await handleSlash(input)) === false) return false;
      } else if (input.startsWith('@')) {
        const sp = input.indexOf(' ');
        const id = (sp < 0 ? input : input.slice(0, sp)).slice(1);
        const rest = sp < 0 ? '' : input.slice(sp + 1).trim();
        const team = findTeam(id);
        if (!team) { out(c.red(`unknown team: @${id}`) + c.gray('  (try /teams)')); }
        else await runTeam(team, rest);
      } else {
        await dispatchInteractive(input);
      }
    } catch (e: any) {
      out(c.red('error: ') + (e?.message || String(e)));
    }
    return true;
  };

  if (process.stdin.isTTY) {
    for (;;) {
      const line = await readBoxedLine(history);
      if (line === null) break;
      const input = line.trim();
      if (input) history.push(input);
      out('');
      if (!(await handle(input))) break;
      out('');
    }
  } else {
    // Non-TTY (piped / scripted): a plain readline loop, serialized via for-await.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt(c.cyan('myrmecia ❯ '));
    rl.prompt();
    try {
      for await (const line of rl) {
        const cont = await handle(line.trim());
        out('');
        if (!cont) break;
        rl.prompt();
      }
    } catch (e: any) {
      if (!/closed/i.test(e?.message || '')) throw e;
    }
    rl.close();
  }
  out(c.gray('bye 🐜'));
  process.exit(0);
}

// --------------------------------------------------------------------- help
function help() {
  out(`${c.bold('myrmecia')} — terminal client for the Myrmecia orchestrator

${c.bold('Interactive mode')}
  myrmecia                         launch the interactive colony shell (banner,
                                   natural-language routing, /slash commands)

${c.bold('One-shot commands')}
  ${c.cyan('health')}                          server status
  ${c.cyan('teams')}                           list agent teams (squads)
  ${c.cyan('@team')} <task...>                 put a team to work (e.g. @feature …)
  ${c.cyan('agents')}                          list agents
  ${c.cyan('models')}                          list models
  ${c.cyan('model')} [id]                      show / switch the active model
  ${c.cyan('templates')}                       list pipeline templates
  ${c.cyan('ask')} <request...>               route a task via the supervisor (live stream)
  ${c.cyan('run')} <agentId> <prompt...>       run a task on an agent (live stream)
  ${c.cyan('pipeline')} <template> <input...>  run a pipeline by name/id (live stream)
  ${c.cyan('supervisor')} <request...>         decompose a one-line request (plan only)
  ${c.cyan('task')} <taskId>                   show a task's status + output

${c.bold('Flags')}
  --server <url>     server base URL (env MYRMECIA_SERVER, default http://localhost:3000)
  --token <token>    API token if auth is enabled (env MYRMECIA_TOKEN)
  -m, --model <id>   force the colony onto a model (env MYRMECIA_MODEL)
  --gate auto|manual pipeline gating mode (default auto)
  --json             raw JSON output
  --no-stream        don't stream; just enqueue and return ids
  -h, --help         this help

${c.bold('Examples')}
  myrmecia                                          # interactive shell
  myrmecia @feature "Add a dark-mode toggle with tests"   # put a team to work
  myrmecia ask "Add a dark-mode toggle with tests"  # route + run
  myrmecia run pm "Write a spec for a dark-mode toggle"
  myrmecia pipeline Feature "Add CSV export to the reports page"
`);
}

// --------------------------------------------------------------------- main
async function main() {
  const cmd = positionals[0];
  const rest = positionals.slice(1);
  if (flags.help) return help();
  if (!cmd) return cmdChat();
  // One-shot team dispatch: `myrmecia @feature build X`
  if (cmd.startsWith('@')) {
    const team = findTeam(cmd.slice(1));
    if (!team) return die(`unknown team: ${cmd}\nrun \`myrmecia teams\` to list teams`);
    INTERACTIVE = true;
    if (flags.model) await setModel(String(flags.model), true).catch(() => {});
    return runTeam(team, rest.join(' ').trim());
  }
  // Apply --model for one-shot commands that run agents.
  if (flags.model && ['ask', 'run', 'exec', 'pipeline', 'pipe'].includes(cmd)) {
    await setModel(String(flags.model), true).catch(() => {});
  }
  switch (cmd) {
    case 'chat': case 'repl': case 'shell': return cmdChat();
    case 'health': return cmdHealth();
    case 'teams': case 'team': return cmdTeams();
    case 'agents': case 'agent': return cmdAgents();
    case 'models': return cmdModels();
    case 'model': await initCurrentModel(); return cmdModelSwitch(rest[0]);
    case 'templates': case 'template': return cmdTemplates();
    case 'run': case 'exec': return cmdRun(rest[0], rest.slice(1));
    case 'ask': return dispatchInteractive(rest.join(' ').trim() || die('usage: myrmecia ask <request...>'));
    case 'pipeline': case 'pipe': return cmdPipeline(rest[0], rest.slice(1));
    case 'supervisor': case 'sup': return cmdSupervisor(rest);
    case 'task': return cmdTask(rest[0]);
    case 'help': return help();
    default: return die(`unknown command: ${cmd}\nrun \`myrmecia --help\` for usage`);
  }
}

main().catch((e) => die(e?.message || String(e)));
