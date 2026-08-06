import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';
import { parse as parseYaml } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const strict = process.argv.includes('--strict');
const checks = [];

function add(name, status, detail) {
  checks.push({ name, status, detail });
}

function hasTool(agent, tool) {
  return (agent.allowed_tools ?? []).includes(tool);
}

function loadEnvironmentHints() {
  const values = { ...process.env };
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) return values;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || values[match[1]] !== undefined) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolvePort => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePort(false);
    });
    socket.once('error', () => resolvePort(false));
  });
}

const registryPath = resolve(root, 'agents/registry.yaml');
if (!existsSync(registryPath)) {
  add('agent_registry', 'fail', 'agents/registry.yaml is missing');
} else {
  const registry = parseYaml(readFileSync(registryPath, 'utf8'));
  const byId = new Map((registry.agents ?? []).map(agent => [agent.id, agent]));
  const required = [
    ['trend-scout', 'mcp__douyin-search__search_videos'],
    ['social-preflight', 'mcp__xiaohongshu__check_login_status'],
    ['social-preflight', 'mcp__douyin-upload__douyin_check_login'],
    ['social-publisher', 'mcp__wechat-official-account__wechat_publish'],
  ];
  for (const [agentId, tool] of required) {
    add(`${agentId}:${tool}`, hasTool(byId.get(agentId) ?? {}, tool) ? 'pass' : 'fail',
      hasTool(byId.get(agentId) ?? {}, tool) ? 'granted' : 'missing tool grant');
  }
}

const environment = loadEnvironmentHints();
let configuredServers = [];
try {
  configuredServers = JSON.parse(environment.MCP_SERVERS || '[]');
} catch {
  add('mcp_configuration', 'fail', 'MCP_SERVERS is not valid JSON');
}
const configuredServerNames = new Set(
  Array.isArray(configuredServers) ? configuredServers.map(server => server?.name).filter(Boolean) : []
);
for (const server of ['xiaohongshu', 'douyin-search', 'douyin-upload']) {
  add(
    `mcp:${server}`,
    configuredServerNames.has(server) ? 'pass' : 'warning',
    configuredServerNames.has(server)
      ? 'configured; runtime connection and login still require a live preflight'
      : 'not configured in MCP_SERVERS'
  );
}
const wechatConfigured = Boolean(
  environment.WECHAT_OFFICIAL_ACCOUNT_APP_ID
  && environment.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET
  && environment.WECHAT_MCP_SECRET_KEY
);
add(
  'mcp:wechat-official-account',
  wechatConfigured ? 'pass' : 'warning',
  wechatConfigured
    ? 'credentials configured; runtime authentication still requires a live preflight'
    : 'required WeChat credential variables are incomplete'
);

for (const relativePath of [
  'docs/social-workflow/compliance-rules.yaml',
  'templates/social-content-three-lanes.yaml',
  'docs/social-workflow/preflight-result.schema.json',
]) {
  add(relativePath, existsSync(resolve(root, relativePath)) ? 'pass' : 'fail',
    existsSync(resolve(root, relativePath)) ? 'available' : 'missing');
}

const comfyUiAvailable = await portOpen(8188);
add('comfyui:8188', comfyUiAvailable ? 'pass' : 'warning',
  comfyUiAvailable ? 'service reachable' : 'not reachable; optional illustration generation will be skipped');

const failures = checks.filter(check => check.status === 'fail');
const warnings = checks.filter(check => check.status === 'warning');
console.log(JSON.stringify({
  checked_at: new Date().toISOString(),
  status: failures.length > 0 ? 'fail' : warnings.length > 0 ? 'degraded' : 'pass',
  checks,
}, null, 2));

if (failures.length > 0 || (strict && warnings.length > 0)) {
  process.exitCode = 1;
}
