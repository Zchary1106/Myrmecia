/**
 * Isolated real-server browser acceptance. Only model transport is scripted.
 * Never use the normal application DB, external MCP, credentials or publishing.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRuntimeCapabilities } from '@myrmecia/shared';
const directory = resolve(process.cwd(), '../../artifacts/agent-runtime-v2/browser');
mkdirSync(directory, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'myrmecia-governance-browser-'));
Object.assign(process.env, {
  DB_PATH: join(root, 'acceptance.sqlite'), MYRMECIA_WORKSPACE_ROOT: root,
  MYRMECIA_RUNTIME_V2: 'true', MYRMECIA_TOOL_READ_CONCURRENCY: '2',
  MYRMECIA_EXECUTION_WORLD: 'host_policy', MCP_SERVERS: '[]', MCP_TOOLS_IN_AGENTS: 'false',
  REDIS_URL: '', REDIS_HOST: '', OPENAI_API_KEY: '', AGENT_FACTORY_API_KEY: '',
  MYRMECIA_API_KEY: '', AGENT_FACTORY_AUTH_TOKEN: '', API_AUTH_TOKEN: '',
  API_AUTH_ENABLED: 'false', AUTH_MODE: 'local', MYRMECIA_MODEL_PROVIDER: 'default',
  MODEL_PROVIDERS: JSON.stringify({ 'scripted-browser-fixture': { baseURL: 'http://fixture.invalid/v1', apiKey: 'fixture-only' } }),
  MODEL_PROVIDER_MAP: '{}',
  MEMORY_EXTRACTION_ENABLED: 'false', MEMORY_REFLECTION_ENABLED: 'false', MEMORY_DECAY_INTERVAL_MS: '0',
  AGENT_FACTORY_DEMO_MODE: 'false', PORT: process.env.PORT || '3340', HOST: '127.0.0.1',
});
const { getDb } = await import('../../src/db/database.js');
const { createAgent } = await import('../../src/db/models/agent.js');
const { createTask, updateTask } = await import('../../src/db/models/task.js');
const { syncBuiltinModels } = await import('../../src/models/model-registry.js');
const { getModelGateway } = await import('../../src/models/gateway.js');
getDb(); syncBuiltinModels();
const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot);
writeFileSync(join(sourceRoot, 'evidence.md'), '# Runtime V2 evidence\nFixture transport; real HTTP/DB/Core/UI.');
createAgent({ id: 'runtime-browser-agent', name: 'Runtime Browser Agent', role: 'analyst',
  allowedTools: ['file_read'], config: { model: 'gpt-5.4-mini', maxTurns: 8, allowedTools: ['file_read'] } });
const seed = createTask({ title: 'Runtime V2 browser acceptance', description: 'Inspect the runtime acceptance fixture.',
  input: 'Inspect the runtime acceptance fixture.', mode: 'direct', assigneeId: 'runtime-browser-agent',
  workspacePath: sourceRoot, workdir: sourceRoot, maxRetries: 0 });
updateTask(seed.id, { status: 'queued' });
const gateway = getModelGateway();
gateway.providerFor = () => 'scripted-browser-fixture';
gateway.runtimeCapabilitiesFor = () => defaultRuntimeCapabilities('host_loop');
gateway.completeForModel = async (_model, params, options) => {
  if (options?.signal?.aborted) throw new Error('Request aborted');
  await new Promise(resolve => setTimeout(resolve, Number(process.env.MYRMECIA_FIXTURE_DELAY_MS || 1500)));
  const messages = params.messages as Array<{ role: string; content?: string }>;
  const last = messages.at(-1);
  const fileTool = params.tools?.find((tool: any) => tool.function.name.includes('file_read'));
  if (fileTool && last?.role === 'user') return {
    choices: [{ message: { role: 'assistant', content: 'Checking scoped evidence…', tool_calls: [
      { id: `fixture-${crypto.randomUUID()}`, type: 'function', function: { name: fileTool.function.name, arguments: '{"path":"evidence.md"}' } },
    ] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
  };
  const envelope = [...messages].reverse().find(message => message.role === 'user')?.content || '';
  const lastUser = envelope.split('NEW user message:').at(-1)!.trim();
  const knowledge = messages.some(message => message.content?.includes('KNOWLEDGE REFERENCES'));
  const content = `## 验收回复\n\n**Runtime Browser Agent** 已读取隔离工作区的证据。\n\n- 当前指令：${lastUser.slice(-180)}\n- 此回复由 fixture 模型提供，HTTP、SQLite、Core、消息队列和页面是真实链路。${knowledge ? '\n- 已使用来源：[K1](#citation-K1)' : ''}\n\n\`\`\`text\nruntime-v2-fixture-ok\n\`\`\``;
  for (const chunk of content.match(/.{1,40}/gs) || []) {
    if (options?.signal?.aborted) throw new Error('Request aborted');
    options?.onDelta?.(chunk);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 50, total_tokens: 80 } };
};
await import('../../src/index.js');
