/**
 * MCP Manager — connects configured MCP servers and aggregates their tools.
 *
 * Config comes from the `MCP_SERVERS` env var (a JSON array of McpServerConfig)
 * or is registered programmatically. Tools are exposed with a qualified name
 * `mcp__<server>__<tool>` so they can be surfaced to agents alongside built-ins.
 */

import { McpClient, type McpServerConfig, type McpToolDef, type McpCallResult } from './mcp-client.js';
import { logger } from '../lib/logger.js';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { consumePublishAuthorization } from '../db/models/publish-authorization.js';
import { getWeChatDraftMediaIds, recordWeChatDraftOutput } from '../db/models/wechat-draft-output.js';

export interface QualifiedMcpTool {
  server: string;
  name: string;
  qualifiedName: string;   // mcp__<server>__<tool>
  description?: string;
  inputSchema?: unknown;
}

const PREFIX = 'mcp__';
export const WECHAT_OFFICIAL_ACCOUNT_MCP = 'wechat-official-account';
export const GOVERNED_PUBLISH_MCP_TOOLS = [
  'mcp__xiaohongshu__publish_content',
  'mcp__xiaohongshu__publish_with_video',
  'mcp__douyin-upload__douyin_upload_video',
  'mcp__wechat-official-account__wechat_publish',
] as const;
const GOVERNED_PUBLISH_MCP_TOOL_SET = new Set<string>(GOVERNED_PUBLISH_MCP_TOOLS);
const WECHAT_DUMMY_APP_ID = 'wx0000000000000000';
const WECHAT_DUMMY_APP_SECRET = '00000000000000000000000000000000';
const WECHAT_MCP_ENV_ALLOW = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];
const require = createRequire(import.meta.url);

export interface WeChatCredentials {
  appId: string;
  appSecret: string;
}

export interface WeChatMcpBootstrap {
  credentials: WeChatCredentials;
  storageKey?: string;
}

export interface McpCallPolicyContext {
  agentId: string;
  taskMode?: string;
  pipelineId?: string;
  stageIndex?: number;
  taskId?: string;
  taskInput?: string;
  workdir?: string;
  publishAuthorized?: boolean;
  approvedDraftTaskIds?: string[];
  approvedPublishTools?: string[];
  publishAuthorizationId?: string;
}

export class McpPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpPolicyError';
  }
}

export function takeWeChatMcpBootstrap(env: NodeJS.ProcessEnv): WeChatMcpBootstrap | undefined {
  const appId = env.WECHAT_OFFICIAL_ACCOUNT_APP_ID?.trim();
  const appSecret = env.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET?.trim();
  const storageKey = env.WECHAT_MCP_SECRET_KEY?.trim();
  delete env.WECHAT_OFFICIAL_ACCOUNT_APP_ID;
  delete env.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET;
  delete env.WECHAT_MCP_SECRET_KEY;
  return appId && appSecret
    ? { credentials: { appId, appSecret }, ...(storageKey ? { storageKey } : {}) }
    : undefined;
}

const startupWeChatBootstrap = takeWeChatMcpBootstrap(process.env);

export function buildWeChatMcpConfig(
  bootstrap = startupWeChatBootstrap,
): McpServerConfig | undefined {
  if (!bootstrap?.storageKey) return undefined;
  const cliPath = require.resolve('wechat-official-account-mcp/dist/src/cli.js');
  const dataRoot = process.env.MYRMECIA_WORKSPACE_ROOT || process.cwd();
  return {
    name: WECHAT_OFFICIAL_ACCOUNT_MCP,
    command: process.execPath,
    // The real AppSecret never enters the process arguments. Valid placeholders
    // allow the upstream CLI to start before configureWeChatMcpClient sends the
    // actual credentials over the private stdio JSON-RPC channel.
    args: [
      cliPath,
      'mcp',
      '-a', WECHAT_DUMMY_APP_ID,
      '-s', WECHAT_DUMMY_APP_SECRET,
    ],
    env: {
      WECHAT_MCP_DB_PATH: process.env.WECHAT_MCP_DB_PATH || join(dataRoot, 'wechat-mcp.db'),
      ...(bootstrap.storageKey ? { WECHAT_MCP_SECRET_KEY: bootstrap.storageKey } : {}),
    },
    envAllow: WECHAT_MCP_ENV_ALLOW,
    envOmit: [
      'WECHAT_OFFICIAL_ACCOUNT_APP_ID',
      'WECHAT_OFFICIAL_ACCOUNT_APP_SECRET',
    ],
  };
}

export async function configureWeChatMcpClient(
  client: Pick<McpClient, 'callTool'>,
  credentials = startupWeChatBootstrap?.credentials,
): Promise<void> {
  if (!credentials) throw new Error('WeChat Official Account credentials are not configured');
  const result = await client.callTool('wechat_auth', {
    action: 'configure',
    appId: credentials.appId,
    appSecret: credentials.appSecret,
  }, 20_000);
  if (result.isError) {
    throw new Error('WeChat Official Account MCP rejected its credential configuration');
  }
}

export function parseMcpServersEnv(raw?: string): McpServerConfig[] {
  const value = raw ?? process.env.MCP_SERVERS;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter(s => s && s.name && s.command);
    return [];
  } catch (err: any) {
    logger.warn({ err: err.message }, 'invalid MCP_SERVERS JSON');
    return [];
  }
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private consumedPublishAuthorizations = new Set<string>();

  /** Connect all servers from config (best-effort; failures are logged, not thrown). */
  async init(configs?: McpServerConfig[]): Promise<void> {
    const configured = [...(configs ?? parseMcpServersEnv())];
    const list = configured.filter(config => config.name !== WECHAT_OFFICIAL_ACCOUNT_MCP);
    if (list.length !== configured.length) {
      logger.warn({ server: WECHAT_OFFICIAL_ACCOUNT_MCP }, 'Ignoring MCP config that uses a reserved server name');
    }
    const builtInWeChat = buildWeChatMcpConfig();
    if (startupWeChatBootstrap && !builtInWeChat) {
      logger.warn('WECHAT_MCP_SECRET_KEY is required; WeChat Official Account MCP was not started');
    }
    if (builtInWeChat) list.push(builtInWeChat);
    for (const cfg of list) {
      try {
        const isBuiltInWeChat = cfg === builtInWeChat;
        const client = await this.addServer(cfg, { allowReservedName: isBuiltInWeChat });
        if (isBuiltInWeChat) {
          await configureWeChatMcpClient(client);
          logger.info({ server: cfg.name }, 'WeChat Official Account MCP configured');
        }
      } catch (err: any) {
        this.removeServer(cfg.name);
        logger.warn({ server: cfg.name, err: err.message }, 'MCP server connect failed');
      }
    }
    if (this.clients.size > 0) {
      logger.info({ servers: this.servers(), tools: this.listTools().length }, 'MCP servers connected');
    }
  }

  async addServer(
    cfg: McpServerConfig,
    options: { allowReservedName?: boolean } = {},
  ): Promise<McpClient> {
    if (cfg.name === WECHAT_OFFICIAL_ACCOUNT_MCP && !options.allowReservedName) {
      throw new McpPolicyError(`MCP server name "${WECHAT_OFFICIAL_ACCOUNT_MCP}" is reserved`);
    }
    const existing = this.clients.get(cfg.name);
    if (existing) existing.dispose();
    const client = new McpClient(cfg);
    await client.connect();
    this.clients.set(cfg.name, client);
    return client;
  }

  removeServer(name: string): boolean {
    const client = this.clients.get(name);
    if (!client) return false;
    client.dispose();
    return this.clients.delete(name);
  }

  servers(): Array<{ name: string; connected: boolean; toolCount: number; serverInfo: unknown }> {
    return [...this.clients.values()].map(c => ({
      name: c.config.name,
      connected: c.isConnected(),
      toolCount: c.tools.length,
      serverInfo: c.serverInfo,
    }));
  }

  listTools(): QualifiedMcpTool[] {
    const out: QualifiedMcpTool[] = [];
    for (const client of this.clients.values()) {
      for (const tool of client.tools) {
        out.push({
          server: client.config.name,
          name: tool.name,
          qualifiedName: `${PREFIX}${client.config.name}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return out;
  }

  /** Call a tool by qualified name (`mcp__server__tool`) or `server` + `tool`. */
  async callTool(
    qualifiedName: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
    policyContext?: McpCallPolicyContext,
  ): Promise<McpCallResult> {
    const { server, tool } = splitQualified(qualifiedName);
    const normalizedName = `${PREFIX}${server}__${tool}`;
    let publishScope: string | undefined;
    if (server === WECHAT_OFFICIAL_ACCOUNT_MCP) {
      assertWeChatMcpCallAllowed(tool, args, policyContext);
      if (tool === 'wechat_publish' && args.action === 'submit') publishScope = 'wechat';
    } else if (GOVERNED_PUBLISH_MCP_TOOL_SET.has(normalizedName)) {
      assertGovernedPublishCallAllowed(normalizedName, policyContext);
      publishScope = normalizedName.startsWith('mcp__xiaohongshu__')
        ? 'xiaohongshu'
        : normalizedName.startsWith('mcp__douyin-upload__')
          ? 'douyin'
          : normalizedName;
    }
    const client = this.clients.get(server);
    if (!client) throw new Error(`MCP server not connected: ${server}`);
    if (publishScope) {
      const authorizationId = policyContext?.publishAuthorizationId;
      if (!authorizationId) {
        throw new McpPolicyError('Live publishing requires a single-use authorization');
      }
      const authorizationKey = `${authorizationId}:${publishScope}`;
      if (this.consumedPublishAuthorizations.has(authorizationKey)) {
        throw new McpPolicyError(`Live publishing authorization for ${publishScope} was already used`);
      }
      if (!consumePublishAuthorization({
        taskId: authorizationId,
        pipelineId: policyContext?.pipelineId,
        stageIndex: policyContext?.stageIndex,
        scope: publishScope,
        toolName: normalizedName,
      })) {
        throw new McpPolicyError(`Live publishing authorization for ${publishScope} was already used`);
      }
      this.consumedPublishAuthorizations.add(authorizationKey);
    }
    const result = await client.callTool(tool, args, timeoutMs);
    if (
      server === WECHAT_OFFICIAL_ACCOUNT_MCP
      && tool === 'wechat_draft'
      && args.action === 'add'
      && !result.isError
      && policyContext?.taskId
      && policyContext.pipelineId
      && policyContext.stageIndex !== undefined
    ) {
      const mediaId = extractWeChatDraftMediaId(result.content);
      if (mediaId) {
        recordWeChatDraftOutput({
          taskId: policyContext.taskId,
          pipelineId: policyContext.pipelineId,
          stageIndex: policyContext.stageIndex,
          mediaId,
        });
      } else {
        logger.warn({
          pipelineId: policyContext.pipelineId,
          stageIndex: policyContext.stageIndex,
        }, 'WeChat draft was created but its Media ID could not be recorded');
      }
    }
    return result;
  }

  dispose(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
    this.consumedPublishAuthorizations.clear();
  }
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(PREFIX);
}

export function isProtectedMcpTool(name: string): boolean {
  try {
    const { server, tool } = splitQualified(name);
    return server === WECHAT_OFFICIAL_ACCOUNT_MCP
      || GOVERNED_PUBLISH_MCP_TOOL_SET.has(`${PREFIX}${server}__${tool}`);
  } catch {
    return false;
  }
}

function assertGovernedPublishCallAllowed(
  qualifiedToolName: string,
  context?: McpCallPolicyContext,
): void {
  if (
    context?.agentId !== 'social-publisher'
    || context.publishAuthorized !== true
    || !context.approvedPublishTools?.includes(qualifiedToolName)
    || !context.publishAuthorizationId
  ) {
    throw new McpPolicyError('Live publishing requires an approved social-publisher pipeline stage');
  }
}

function assertWorkspaceFile(workdir: string | undefined, filePath: unknown): void {
  if (!workdir || typeof filePath !== 'string' || !filePath.trim()) {
    throw new McpPolicyError('WeChat media upload requires a workspace file path');
  }
  if (!isAbsolute(filePath)) {
    throw new McpPolicyError('WeChat media upload requires an absolute workspace file path');
  }
  const root = resolve(workdir);
  const target = resolve(filePath);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
  } catch {
    throw new McpPolicyError('WeChat media upload requires an existing workspace file');
  }
  const rel = relative(realRoot, realTarget);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new McpPolicyError('WeChat media upload path must stay inside the task workspace');
  }
  if (!statSync(realTarget).isFile()) {
    throw new McpPolicyError('WeChat media upload path must reference a file');
  }
}

function extractWeChatDraftMediaId(content: unknown): string | undefined {
  const text = Array.isArray(content)
    ? content.map(block =>
        typeof block === 'object'
        && block !== null
        && 'text' in block
        && typeof block.text === 'string'
          ? block.text
          : ''
      ).join('\n')
    : typeof content === 'string'
      ? content
      : '';
  return text.match(/(?:^|\n)草稿ID:\s*([^\s]+)(?:\s|$)/)?.[1];
}

function assertWeChatMcpCallAllowed(
  tool: string,
  args: Record<string, unknown>,
  context?: McpCallPolicyContext,
): void {
  if (!context) {
    throw new McpPolicyError('WeChat Official Account tools require a governed agent execution context');
  }
  const action = typeof args.action === 'string' ? args.action : '';

  if (tool === 'wechat_permanent_media') {
    if (context.agentId !== 'wechat-writer') {
      throw new McpPolicyError('Only wechat-writer may manage WeChat article media');
    }
    if (!['add', 'get', 'list', 'count'].includes(action)) {
      throw new McpPolicyError(`WeChat permanent media action "${action || 'missing'}" is not allowed`);
    }
    if (action === 'add') {
      if (args.fileData !== undefined) {
        throw new McpPolicyError('Base64 WeChat media uploads are not allowed');
      }
      if (args.type !== 'image') {
        throw new McpPolicyError('WeChat article covers must be uploaded as image media');
      }
      assertWorkspaceFile(context.workdir, args.filePath);
    }
    return;
  }

  if (tool === 'wechat_draft') {
    if (context.agentId !== 'wechat-writer') {
      throw new McpPolicyError('Only wechat-writer may manage WeChat article drafts');
    }
    if (!['add', 'get', 'list', 'count'].includes(action)) {
      throw new McpPolicyError(`WeChat draft action "${action || 'missing'}" is not allowed`);
    }
    return;
  }

  if (tool === 'wechat_publish') {
    if (context.agentId !== 'social-publisher') {
      throw new McpPolicyError('Only social-publisher may access WeChat publication operations');
    }
    if (!['submit', 'get', 'list'].includes(action)) {
      throw new McpPolicyError(`WeChat publish action "${action || 'missing'}" is not allowed`);
    }
    if (action === 'submit') {
      assertGovernedPublishCallAllowed(
        'mcp__wechat-official-account__wechat_publish',
        context,
      );
      const mediaId = typeof args.mediaId === 'string' ? args.mediaId.trim() : '';
      const trustedMediaIds = context.pipelineId
        ? getWeChatDraftMediaIds(context.pipelineId, context.approvedDraftTaskIds || [])
        : [];
      if (mediaId.length < 8 || trustedMediaIds.length !== 1 || trustedMediaIds[0] !== mediaId) {
        throw new McpPolicyError('WeChat publication mediaId must exactly match the recorded draft-stage output');
      }
    }
    return;
  }

  throw new McpPolicyError(`WeChat MCP tool "${tool}" is not exposed to agents`);
}

function splitQualified(qualifiedName: string): { server: string; tool: string } {
  const rest = qualifiedName.startsWith(PREFIX) ? qualifiedName.slice(PREFIX.length) : qualifiedName;
  const sep = rest.indexOf('__');
  if (sep < 0) throw new Error(`invalid MCP tool name: ${qualifiedName}`);
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

// ---------- Singleton ----------

let manager: McpManager | null = null;

export function getMcpManager(): McpManager {
  if (!manager) manager = new McpManager();
  return manager;
}

export function resetMcpManager(): void {
  manager?.dispose();
  manager = null;
}
