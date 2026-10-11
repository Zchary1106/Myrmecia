import { createHash } from 'node:crypto';
import type { AgentDefinition, AgentSetupPreflight } from '../types.js';
import { getDb } from '../db/database.js';
import { getModel } from '../models/model-registry.js';
import { getModelGateway, readProviders } from '../models/gateway.js';
import { getSkillVersion } from '../db/models/skill.js';
import { resolveAllowedToolsForAgent } from '../tools/tool-policy.js';
import { getMcpManager, isMcpTool, isProtectedMcpTool } from '../tools/mcp-manager.js';
import { mcpToolsEnabled } from '../tools/mcp-tools.js';
import { xiaohongshuSession } from '../tools/xiaohongshu-session.js';
import { HttpError } from '../routes/http.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

/** The entity and request receipt commit together; replay never creates a new entity. */
export function setupEntity(data: {
  workspaceId: string; actorId: string; operation: string; key?: string; payload: unknown;
}, create: () => string): { id: string; replayed: boolean } {
  if (!data.key) return { id: create(), replayed: false };
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(data.key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', 'Invalid setup request key');
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical(data.payload))).digest('hex');
  const db = getDb();
  return db.transaction(() => {
    const row = db.get<{ fingerprint: string; entity_id: string }>(
      'SELECT fingerprint, entity_id FROM agent_setup_requests WHERE workspace_id = ? AND actor_id = ? AND operation = ? AND request_key = ?',
      data.workspaceId, data.actorId, data.operation, data.key,
    );
    if (row) {
      if (row.fingerprint !== fingerprint) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This request key belongs to a different setup payload');
      return { id: row.entity_id, replayed: true };
    }
    const id = create();
    db.run('INSERT INTO agent_setup_requests (workspace_id, actor_id, operation, request_key, fingerprint, entity_id) VALUES (?, ?, ?, ?, ?, ?)',
      data.workspaceId, data.actorId, data.operation, data.key, fingerprint, id);
    return { id, replayed: false };
  });
}

/** A local snapshot, not a model generation or integration login/health probe. */
export function preflightAgent(agent: AgentDefinition, skillVersionId?: string): AgentSetupPreflight {
  const checks: AgentSetupPreflight['checks'] = [];
  const add = (id: string, label: string, status: AgentSetupPreflight['checks'][number]['status'], blocking: boolean, message: string) =>
    checks.push({ id, label, status, blocking, message });
  const requestedId = agent.model || agent.config.model || '';
  const model = getModel(requestedId);
  const gateway = getModelGateway();
  const provider = gateway.providerFor(requestedId);
  if (agent.config.governanceBudget && gateway.runtimeCapabilitiesFor?.(requestedId).executionMode === 'provider_loop') {
    add('budget-runtime', '预算执行能力', 'unavailable', true,
      'Provider 内部循环不支持这些硬限额。请选择 host-loop 模型或取消该预算配置；预检不会派发调用。');
  }
  const config = readProviders()[provider];
  if (!model || !model.enabled || model.healthStatus === 'disabled') {
    add('model', '模型', 'unavailable', true, '所选模型不在已启用的模型目录中；请重新选择。');
  } else if (!config || config.type === 'openai' && !config.apiKey) {
    add('model', '模型', 'unavailable', true, '模型路由的 Provider 未配置可用认证；请在 Models 检查。');
  } else {
    const healthFresh = model.lastCheckedAt
      && Date.now() - Date.parse(/^\d{4}-\d{2}-\d{2} /.test(model.lastCheckedAt)
        ? `${model.lastCheckedAt.replace(' ', 'T')}Z` : model.lastCheckedAt) < 300_000;
    add('model', '模型', model.healthStatus === 'healthy' && healthFresh ? 'available' : 'unknown', false,
      model.healthStatus === 'healthy' && healthFresh ? '模型目录已启用，最近健康记录正常；本次未发起模型请求。'
        : model.healthStatus === 'healthy' ? '模型目录已启用，历史健康记录正常但可能已过期；本次未验证当前可用性。'
        : '模型目录已启用，但尚未验证当前可用性；显式试运行会消耗实际模型额度。');
    if (config.type === 'copilot') add('provider-auth', 'Provider 登录', 'unknown', false,
      '本次未读取凭证或探测 Copilot 登录；请在 Models 确认账号，试运行将验证实际访问。');
  }
  if (skillVersionId) {
    const skill = getSkillVersion(skillVersionId);
    add('skill', 'Skill', skill?.status === 'published' ? 'available' : 'unavailable', skill?.status !== 'published',
      skill?.status === 'published' ? '选中的 Skill 版本已发布。' : 'Skill 版本不存在或未发布，请重新选择。');
  }
  const policy = resolveAllowedToolsForAgent(agent);
  const servers = new Map(getMcpManager().servers().map(server => [server.name, server]));
  const connected = new Set(getMcpManager().listTools().map(tool => tool.qualifiedName));
  for (const decision of policy.decisions) {
    const id = decision.toolId;
    const label = id;
    if (isMcpTool(id)) {
      const serverName = id.slice(5).split('__')[0];
      if (!mcpToolsEnabled() || !servers.get(serverName)?.connected || !connected.has(id)) {
        add(id, label, 'unavailable', true, 'MCP 未连接、工具未发现或 Agent MCP 功能被禁用；请在 Home 检查连接。');
        continue;
      }
      if (!decision.allowed) {
        add(id, label, 'unavailable', true, `当前工具策略不允许调用：${decision.reason}`);
        continue;
      }
      const authTools = new Set(['get_login_qrcode', 'check_login_status', 'delete_cookies']);
      if (isProtectedMcpTool(id) || authTools.has(id.split('__').at(-1)!)) {
        add(id, label, 'requires_approval', false, '受平台治理保护，需通过专用审批/发布流程；普通聊天试运行不会获得额外权限。');
      } else {
        add(id, label, 'available', false, 'MCP 已连接且工具已发现；本次未执行工具。');
      }
      if (serverName === 'xiaohongshu') {
        const login = xiaohongshuSession.cachedStatus();
        if (!checks.some(check => check.id === 'xiaohongshu-login')) add('xiaohongshu-login', '小红书登录',
          login?.authenticated ? 'available' : login ? 'unavailable' : 'unknown', !login?.authenticated,
          login?.authenticated ? '最近缓存的登录验证通过；执行时仍会重新检查。'
            : '没有当前有效的登录确认；请到 Home 检查登录后重新预检。本次不会弹码或排队探测。');
      }
    } else {
      add(id, label, decision.allowed ? 'available' : decision.approvalRequired ? 'requires_approval' : 'unavailable',
        !decision.allowed && !decision.approvalRequired,
        decision.allowed ? '当前工具策略允许调用；本次未执行工具。'
          : decision.approvalRequired ? '需要现有审批授权，试运行不会绕过审批；Agent 可能无法完成依赖此工具的任务。'
          : `当前工具策略不允许调用：${decision.reason}`);
    }
  }
  const canTest = !checks.some(check => check.blocking);
  return { checkedAt: new Date().toISOString(), canTest, status: checks.some(check => check.status !== 'available') ? 'needs_attention' : 'ready_for_test',
    model: { requestedId, provider, health: model?.healthStatus || 'unknown' }, checks };
}
