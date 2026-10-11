/**
 * Opt-in actual SDK/MCP acceptance. Never use the normal application database.
 * Seed and resume must be invoked in separate OS processes. No fixture model,
 * account switch, dependency installation or publishing is permitted.
 */
import '../src/load-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyXiaohongshuSources } from '../src/testing/xiaohongshu-source-verification.js';
import { connect } from 'node:net';

const argument = (key: string) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const phase = argument('case');
if (!['sdk-seed', 'sdk-resume', 'xhs', 'xhs-probe', 'xhs-evidence'].includes(phase || '')) throw new Error('Choose --case=sdk-seed|sdk-resume|xhs|xhs-probe|xhs-evidence');
if (process.env.MYRMECIA_RUNTIME_LIVE_INTEGRATIONS !== 'true') throw new Error('LIVE_INTEGRATIONS_NOT_AUTHORIZED');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const artifactRoot = join(repository, 'artifacts/agent-runtime-v2');
const rootArgument = argument('root');
if (!rootArgument || !isAbsolute(rootArgument)) throw new Error('An absolute --root within artifacts/agent-runtime-v2 is required');
const directory: string = rootArgument;
const artifactRelative = relative(artifactRoot, directory);
if (!artifactRelative || artifactRelative === '..' || artifactRelative.startsWith(`..${sep}`) || isAbsolute(artifactRelative)) {
  throw new Error('Live acceptance must have its own nested artifact directory');
}
mkdirSync(directory, { recursive: true });
const model = process.env.AGENT_FACTORY_MODEL;
if (!model) throw new Error('Use an already configured AGENT_FACTORY_MODEL');
const configuredServers = process.env.MCP_SERVERS;
const configuredServices = process.env.MCP_LOCAL_SERVICES;
Object.assign(process.env, {
  DB_PATH: join(directory, phase?.startsWith('xhs') ? 'xhs.sqlite' : 'sdk.sqlite'),
  MYRMECIA_WORKSPACE_ROOT: directory,
  MYRMECIA_RUNTIME_V2: 'true', MYRMECIA_EXECUTION_WORLD: 'host_policy',
  AGENT_MAX_WALL_CLOCK_MS: '180000', AGENT_MAX_EXECUTION_TOKENS: '40000',
  AGENT_MAX_RESPONSE_TOKENS: '2000', AGENT_MAX_TOOL_CALLS: '3',
  REDIS_URL: '', REDIS_HOST: '', MCP_SERVERS: '[]', MCP_LOCAL_SERVICES: '{}',
  MEMORY_EXTRACTION_ENABLED: 'false', MEMORY_REFLECTION_ENABLED: 'false',
  LOG_LEVEL: 'warn',
});
// A separately configured WeChat account is not part of this acceptance.
delete process.env.WECHAT_OFFICIAL_ACCOUNT_APP_ID;
delete process.env.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET;
delete process.env.WECHAT_MCP_SECRET_KEY;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hasListener = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({ host: '127.0.0.1', port });
  const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(300, () => finish(false));
});
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n');
const startedAt = Date.now();
const report: Record<string, unknown> = {
  schemaVersion: 1, mode: 'live', case: phase, model,
  boundary: 'Existing account; read-only; isolated SQLite; no production changes',
  status: 'failed',
};
const { getDb, closeDb } = await import('../src/db/database.js');
const { createAgent } = await import('../src/db/models/agent.js');
const { createTask, getTask } = await import('../src/db/models/task.js');
const { createExecution, getExecution } = await import('../src/db/models/execution.js');
const { getModel, syncBuiltinModels } = await import('../src/models/model-registry.js');
const { syncBuiltinTools } = await import('../src/tools/tool-registry.js');
const { getModelGateway, shutdownModelGateway } = await import('../src/models/gateway.js');
syncBuiltinModels(); syncBuiltinTools();
if (!getModel(model)) throw new Error('Configured model is not registered');
const gateway = getModelGateway();
if (gateway.providerFor(model) !== 'copilot') throw new Error('This acceptance requires the already configured Copilot provider');
let shutdownMcp: (() => Promise<void>) | undefined;
let serve = false;

async function collectXhsEvidence(taskId: string) {
  const { listSessionEvents, agentSessionForTask } = await import('../src/db/models/agent-session-event.js');
  const task = getTask(taskId);
  if (!task) throw new Error('LIVE_XHS_TASK_MISSING');
  const executionRow = getDb().get<{ id: string }>('SELECT id FROM task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1', task.id);
  if (!executionRow) throw new Error('LIVE_XHS_EXECUTION_MISSING');
  const execution = getExecution(executionRow.id)!;
  const tools = getDb().all<any>('SELECT * FROM tool_executions WHERE execution_id = ?', execution.id);
  // MCP tools are journalled in the ledger/messages, not the native tools table.
  const ledger = getDb().all<any>('SELECT id, type, decision, metadata FROM execution_ledger WHERE execution_id = ? ORDER BY seq', execution.id);
  const mcpCalls = ledger.filter(entry => entry.type === 'tool.executed').map(entry => {
    const metadata = JSON.parse(entry.metadata || '{}');
    return { ledgerId: entry.id, name: metadata.toolName, status: entry.decision,
      durationMs: metadata.durationMs, diagnostics: metadata.diagnostics };
  });
  const search = mcpCalls.find(tool => tool.name === 'mcp__xiaohongshu__search_feeds');
  const output = String(task.output || '');
  const results = getDb().all<{ content: string }>(
    "SELECT content FROM execution_messages WHERE execution_id = ? AND type = 'tool_result' AND tool_name = ? ORDER BY id",
    execution.id, 'mcp__xiaohongshu__search_feeds');
  const notes: unknown[] = [];
  for (const result of results) {
    try {
      const envelope = JSON.parse(result.content);
      const data = typeof envelope.output === 'string' ? JSON.parse(envelope.output) : envelope;
      if (Array.isArray(data.notes)) notes.push(...data.notes);
    } catch { /* Failed or unrecognized tool output is not verified evidence. */ }
  }
  const sourceEvidence = verifyXiaohongshuSources(notes, output);
  const events = listSessionEvents({ workspaceId: 'default', sessionId: agentSessionForTask(task), limit: 1000 });
  Object.assign(report, {
    taskId: task.id, executionId: execution.id, sessionId: agentSessionForTask(task),
    status: search?.status === 'done' && sourceEvidence.passed && execution.status === 'done' ? 'passed' : 'failed',
    executionStatus: execution.status, taskStatus: task.status, stopReason: execution.runState?.stopReason,
    toolEvidence: tools.map(tool => ({ id: tool.id, name: tool.tool_id, status: tool.status,
      inputHash: hash(tool.input_summary || ''), outputHash: hash(tool.output_summary || '') })),
    mcpEvidence: mcpCalls,
    sourceEvidence,
    eventRefs: events.map(event => ({ id: event.eventId, sequence: event.sequence, type: event.type, hash: event.payloadHash })),
    verification: execution.runState?.verification, metrics: execution.runState?.metrics,
    outputHash: hash(output), outputCharacters: output.length,
  });
  // This is the actual DLP-checked model answer, not a regenerated substitute.
  writeFileSync(join(directory, 'xhs-answer.md'), output + '\n');
}

try {
  if (phase === 'xhs-evidence') {
    const existing = getDb().get<{ id: string }>('SELECT id FROM tasks WHERE assignee_id = ? ORDER BY created_at DESC LIMIT 1', 'live-xhs-readonly');
    if (!existing) throw new Error('LIVE_XHS_TASK_MISSING');
    report.mode = 'live-evidence-replay';
    report.newModelOrMcpRequests = 0;
    await collectXhsEvidence(existing.id);
    serve = process.argv.includes('--serve');
  } else if (phase === 'sdk-seed' || phase === 'sdk-resume') {
    const { prepareProviderSession } = await import('../src/models/provider-session.js');
    const { withOwnedRun } = await import('../src/agents/run-coordinator.js');
    const seedPath = join(directory, 'sdk-seed-input.json');
    if (phase === 'sdk-seed' && existsSync(seedPath)) throw new Error('Refusing to overwrite a prior seed');
    if (phase === 'sdk-seed') {
      createAgent({ id: 'live-sdk-continuity', name: 'Live SDK continuity', role: 'analyst',
        config: { model, maxTurns: 3, allowedTools: [] }, allowedTools: [] });
      const task = createTask({ title: 'Live SDK continuity acceptance', input: 'Read-only continuity acceptance',
        description: 'Synthetic existing-account session test', mode: 'direct', assigneeId: 'live-sdk-continuity',
        modelId: model, workspaceId: 'default', workdir: directory, workspacePath: directory, maxRetries: 0 });
      save('sdk-seed-input.json', { taskId: task.id, marker: `continuity-${randomUUID()}`, seedPid: process.pid, model });
    }
    const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
    if (seed.model !== model) throw new Error('Model changed between continuity workers');
    if (phase === 'sdk-resume' && seed.seedPid === process.pid) throw new Error('Resume must run in a separate OS process');
    const task = getTask(seed.taskId)!;
    if (!task) throw new Error('Isolated seed task not found');
    const run = createExecution({ taskId: task.id, agentDefId: task.assigneeId!, workspaceId: 'default' });
    await withOwnedRun(task, async () => {
      const system = 'This is a read-only session continuity test. Never call tools. Follow the latest user instruction exactly.';
      // Critically, the resumed request has no marker or previous turn. Only the
      // actual SDK session can supply the nonce; host history cannot fake this.
      const prompt = phase === 'sdk-seed'
        ? `Remember this private synthetic marker for the next turn: ${seed.marker}. Reply with only STORED.`
        : 'What private synthetic marker did I ask you to remember in the previous turn? Reply with only the marker.';
      const messages = [{ role: 'system' as const, content: [{ type: 'text' as const, text: system }] },
        { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] }];
      const session = prepareProviderSession(task, run.id, randomUUID(), { modelId: model, messages });
      if (phase === 'sdk-resume' && !session.options.resumeSessionId) throw new Error('Stable SDK continuity was not selected');
      let observed: { sessionHash: string; resumed: boolean } | undefined;
      const ready = session.options.onSessionReady!;
      let streamedCharacters = 0;
      const result = await gateway.completeForModel(model, {
        model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }, {
        timeoutMs: 60000, idleTimeoutMs: 45000, signal: AbortSignal.timeout(65000),
        onDelta: delta => { streamedCharacters += delta.length; },
        providerSession: { ...session.options, onSessionReady: (id, resumed) => {
          ready(id, resumed); observed = { sessionHash: hash(id), resumed };
        } },
      });
      const pendingBlocked = !prepareProviderSession(task, run.id, randomUUID(), { modelId: model, messages }).options.resumeSessionId;
      if (!pendingBlocked) throw new Error('Pending SDK state was incorrectly resumable');
      if (result.usage?.session_cleanup_confirmed === false) throw new Error('SDK disconnect was not confirmed');
      session.settle();
      const output = String(result.choices[0].message.content || '').trim();
      const stable = getDb().get<{ status: string }>('SELECT status FROM agent_provider_sessions WHERE task_id = ?', task.id);
      const seedEvidence = phase === 'sdk-resume' ? JSON.parse(readFileSync(join(directory, 'sdk-seed.json'), 'utf8')) : undefined;
      const passed = phase === 'sdk-seed'
        ? output === 'STORED' && observed?.resumed === false && stable?.status === 'stable'
        : output === seed.marker && observed?.resumed === true && stable?.status === 'stable'
          && observed?.sessionHash === seedEvidence?.sessionHash;
      Object.assign(report, {
        status: passed ? 'passed' : 'failed', taskId: task.id, executionId: run.id, workerPid: process.pid,
        ...observed, stableBoundary: stable?.status === 'stable', pendingResumeBlocked: pendingBlocked,
        markerMatched: phase === 'sdk-resume' ? output === seed.marker : null,
        hostReplayedPriorMessages: false, streamedCharacters, responseHash: hash(output),
        costUSD: result.usage?.cost_usd ?? null, costType: result.usage?.cost_type ?? 'unavailable',
        inputTokens: result.usage?.input_tokens_observed ? result.usage.prompt_tokens : null,
        outputTokens: result.usage?.output_tokens_observed ? result.usage.completion_tokens : null,
        actualModelId: result.usage?.actual_model_id ?? null,
        runContinuity: getExecution(run.id)?.runState?.providerContinuity ?? null,
        limitation: 'Settled read-only SDK continuity across process exit, not automatic replay of unknown in-flight work',
      });
      if (!passed) throw new Error('LIVE_SDK_CONTINUITY_ASSERTION_FAILED');
    });
  } else {
    const { getMcpManager, parseMcpServersEnv } = await import('../src/tools/mcp-manager.js');
    const manager = getMcpManager();
    shutdownMcp = () => manager.shutdown();
    const server = parseMcpServersEnv(configuredServers).find(entry => entry.name === 'xiaohongshu');
    if (!server) throw new Error('Xiaohongshu connector is not configured');
    // Reuse an installed mcp-remote entry point. Never let npx install or update
    // a dependency as a side effect of an acceptance run.
    if (server.command.endsWith('/npx') || server.command === 'npx') {
      const bridge = argument('bridge');
      if (!bridge || !isAbsolute(bridge) || !existsSync(bridge)) throw new Error('Supply --bridge=<installed mcp-remote/dist/proxy.js>');
      const installedPackage = JSON.parse(readFileSync(resolve(dirname(bridge), '../package.json'), 'utf8'));
      if (installedPackage.name !== 'mcp-remote'
        || resolve(dirname(bridge), '..', installedPackage.bin?.['mcp-remote'] || '') !== resolve(bridge)) {
        throw new Error('Bridge must be the installed mcp-remote stdio proxy, not its diagnostic client');
      }
      const args = server.args || [];
      const packageIndex = args.indexOf('mcp-remote');
      if (packageIndex < 0) throw new Error('Unsupported npx connector; installation is not authorized');
      server.command = process.execPath;
      server.args = [bridge, ...args.slice(packageIndex + 1)];
    }
    const services = JSON.parse(configuredServices || '{}');
    const connector = argument('connector');
    if ((connector || process.argv.includes('--headful')) && services.xiaohongshu
      && await hasListener(services.xiaohongshu.port)) {
      throw new Error('STAGED_CONNECTOR_PORT_ALREADY_IN_USE');
    }
    if (connector) {
      if (!isAbsolute(connector) || !existsSync(connector) || !services.xiaohongshu) {
        throw new Error('A staged connector requires an existing local-service configuration and absolute executable');
      }
      services.xiaohongshu.command = connector;
      report.connectorSha256 = createHash('sha256').update(readFileSync(connector)).digest('hex');
    }
    if (process.argv.includes('--headful')) {
      if (!services.xiaohongshu) throw new Error('Visible-browser diagnosis requires a configured local connector');
      services.xiaohongshu.args = [...(services.xiaohongshu.args || []), '-headless=false'];
      report.visibleBrowserDiagnostic = true;
    }
    process.env.MCP_LOCAL_SERVICES = JSON.stringify(services.xiaohongshu ? { xiaohongshu: services.xiaohongshu } : {});
    process.env.MCP_TOOLS_IN_AGENTS = 'true';
    await manager.init([server]);
    const toolNames = manager.listTools().filter(tool => tool.server === 'xiaohongshu').map(tool => tool.qualifiedName);
    report.connected = toolNames.includes('mcp__xiaohongshu__search_feeds');
    report.discoveredTools = toolNames;
    if (!report.connected) throw new Error('XHS_HANDSHAKE_FAILED');
    const { xiaohongshuSession } = await import('../src/tools/xiaohongshu-session.js');
    const login = await xiaohongshuSession.status();
    report.login = login;
    if (!login.authenticated) {
      report.status = login.state === 'login_required' ? 'login_required' : 'unavailable';
      throw new Error(login.state === 'login_required' ? 'XHS_USER_LOGIN_REQUIRED' : 'XHS_LOGIN_CHECK_UNAVAILABLE');
    }
    if (phase === 'xhs-probe') {
      // One controlled transport diagnostic, not an automatic model retry. The
      // 70s probe distinguishes the adapter's 55s deadline from the connector's
      // own 60s page deadline. Never persist or print the raw signed response.
      const probeStarted = Date.now();
      const raw = await manager.callTool('mcp__xiaohongshu__search_feeds', { keyword: '手冲咖啡入门' }, 70000);
      const text = typeof raw.content === 'string' ? raw.content
        : Array.isArray(raw.content) ? raw.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n') : '';
      let feeds = 0;
      try {
        const parsed = JSON.parse(text);
        feeds = (parsed.feeds || parsed.data?.feeds || []).length;
      } catch { /* Report recognized error classes, not server messages. */ }
      Object.assign(report, {
        status: !raw.isError && feeds > 0 ? 'passed' : 'failed', probeDurationMs: Date.now() - probeStarted,
        isError: raw.isError === true, recognizedFeedCount: feeds, contentHash: hash(text),
        failureClass: !raw.isError && feeds > 0 ? null : /context deadline exceeded|timeout|timed out/i.test(text) ? 'upstream_deadline'
          : /captcha|verify|安全验证|风控/i.test(text) ? 'challenge'
            : /未登录|login required|not logged in/i.test(text) ? 'login_required'
              : /NoFeeds|没有|未找到/i.test(text) ? 'no_feeds' : raw.isError ? 'upstream_error' : 'unrecognized_response',
        limitation: 'Direct transport diagnostic only; does not establish model/runtime/UI acceptance',
      });
      if (report.status !== 'passed') throw new Error('LIVE_XHS_PROBE_FAILED');
    } else {
    const allowedTools = ['mcp__xiaohongshu__search_feeds', 'mcp__xiaohongshu__get_feed_detail'];
    const agent = createAgent({ id: 'live-xhs-readonly', name: '小红书真实只读验收', role: 'analyst',
      config: { model, maxTurns: 4, allowedTools }, allowedTools });
    const input = '这是一次小红书只读检索验收。请必须调用小红书 search_feeds，关键词“手冲咖啡入门”，只搜索一次，不必读详情。'
      + '根据工具真实返回的 notes 数组，用 Markdown 严格列出 notes[0]、notes[1]、notes[2]，顺序不能变；若不足三条则只列实际条数。'
      + '每条原样复制该条的 title 和 source_url，不改写标题，不选其他序号，不增加链接。说明资料来自小红书 MCP。'
      + '不要调用其他工具、不发布、不点赞、不评论；如果搜索失败，明确说明失败，不得编造笔记。';
    const task = createTask({ title: '小红书 MCP 真实搜索验收', description: input, input, mode: 'direct',
      modelId: model, assigneeId: agent.id, workspaceId: 'default', workdir: directory, workspacePath: directory,
      maxRetries: 0, completionCriteria: [
        { id: 'source-url', label: '真实小红书笔记来源链接', required: true, verifier: 'output_contains', text: 'xiaohongshu.com/explore/' },
      ] });
    const { AgentRuntime } = await import('../src/agents/agent-runtime.js');
    console.log('XHS_SEARCH_START: real provider → runtime → MCP; one read-only query');
    let executionError: unknown;
    try {
      await new AgentRuntime().execute(agent, task);
    } catch (error) {
      // A failed completion gate still has authoritative SQLite/ledger evidence.
      executionError = error;
    }
    await collectXhsEvidence(task.id);
    if (report.status !== 'passed' || executionError) throw new Error('LIVE_XHS_TASK_ASSERTION_FAILED');
    serve = process.argv.includes('--serve');
    }
  }
} catch (error) {
  // Save only controlled error codes, never an SDK/MCP exception that may carry
  // credentials, signed URLs or request arguments.
  const message = error instanceof Error ? error.message : '';
  report.errorCode = /^[A-Z][A-Z0-9_]+$/.test(message) ? message : 'LIVE_INTEGRATION_FAILED';
  process.exitCode = 1;
} finally {
  report.durationMs = Date.now() - startedAt;
  save(`${phase}.json`, report);
  console.log(JSON.stringify(report, null, 2));
  console.log(`REPORT ${join(directory, `${phase}.json`)}`);
  await shutdownModelGateway();
  if (!serve) {
    await shutdownMcp?.();
    const { closeEnvironmentFetch } = await import('../src/lib/environment-fetch.js');
    await closeEnvironmentFetch();
    closeDb();
  }
}
if (serve) {
  Object.assign(process.env, { PORT: process.env.PORT || '3360', HOST: '127.0.0.1',
    MCP_SERVERS: '[]', MCP_LOCAL_SERVICES: '{}', API_AUTH_TOKEN: '', API_AUTH_ENABLED: 'false', AUTH_MODE: 'local',
    MEMORY_DECAY_INTERVAL_MS: '0', AGENT_FACTORY_DEMO_MODE: 'false' });
  console.log('Starting isolated production backend for real-result browser acceptance');
  await import('../src/index.js');
} else {
  await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
  process.exit(process.exitCode || 0);
}
