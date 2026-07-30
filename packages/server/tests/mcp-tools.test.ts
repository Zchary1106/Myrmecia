/**
 * Tests for the MCP → agent tool-loop bridge.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { McpManager } from '../src/tools/mcp-manager.js';
import { getMcpManager, resetMcpManager } from '../src/tools/mcp-manager.js';
import { getMcpToolDefinitions, executeMcpTool, mcpResultToString } from '../src/tools/mcp-tools.js';
import { resolveAllowedToolsForAgent } from '../src/tools/tool-policy.js';
import { getDb } from '../src/db/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK = join(__dirname, 'fixtures', 'mock-mcp-server.mjs');

afterEach(() => {
  resetMcpManager();
  getDb().run('DELETE FROM publish_authorization_consumptions');
  getDb().run('DELETE FROM wechat_draft_outputs');
});

describe('mcpResultToString', () => {
  it('flattens text content blocks', () => {
    expect(mcpResultToString([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(mcpResultToString('plain')).toBe('plain');
  });
});

describe('MCP tool-loop bridge', () => {
  it('builds model tool defs and executes via the manager', async () => {
    // Connect a server through the singleton manager (used by the bridge).
    const mgr = getMcpManager();
    await mgr.init([{ name: 'mock', command: process.execPath, args: [MOCK] }]);

    const { defs, nameToQualified } = getMcpToolDefinitions();
    const names = defs.map(d => d.function.name);
    expect(names).toContain('mcp__mock__echo');
    expect(nameToQualified.get('mcp__mock__echo')).toBe('mcp__mock__echo');
    // Each def carries a JSON-schema parameters object.
    expect(defs[0].function.parameters).toBeTypeOf('object');

    const res = await executeMcpTool('mcp__mock__add', { a: 4, b: 5 });
    expect(res.status).toBe('done');
    expect(res.output).toContain('9');
  });

  it('respects MCP_TOOLS_IN_AGENTS=false', async () => {
    process.env.MCP_TOOLS_IN_AGENTS = 'false';
    try {
      const mgr = getMcpManager();
      await mgr.init([{ name: 'mock', command: process.execPath, args: [MOCK] }]);
      const { defs } = getMcpToolDefinitions();
      expect(defs.length).toBe(0);
    } finally {
      delete process.env.MCP_TOOLS_IN_AGENTS;
    }
  });

  it('surfaces only explicitly allowed MCP tools to an agent', async () => {
    const mgr = getMcpManager();
    await mgr.init([{ name: 'mock', command: process.execPath, args: [MOCK] }]);
    const echoTool = 'mcp__mock__echo';

    const policy = resolveAllowedToolsForAgent({
      id: 'mcp-limited-agent',
      name: 'MCP Limited Agent',
      role: 'test',
      capabilities: [],
      allowedTools: [echoTool],
      config: {},
      stats: { tasksCompleted: 0, tasksFailed: 0, avgDuration: 0, successRate: 0 },
    } as any);
    expect(policy.allowedTools).toEqual([echoTool]);

    const { defs, nameToQualified } = getMcpToolDefinitions(new Set(policy.allowedTools));
    expect([...nameToQualified.values()]).toEqual([echoTool]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toContain('echo');
  });

  it('does not allow unavailable MCP tools through policy resolution', () => {
    const policy = resolveAllowedToolsForAgent({
      id: 'mcp-unavailable-agent',
      name: 'MCP Unavailable Agent',
      role: 'test',
      capabilities: [],
      allowedTools: ['mcp__missing__publish'],
      config: {},
      stats: { tasksCompleted: 0, tasksFailed: 0, avgDuration: 0, successRate: 0 },
    } as any);

    expect(policy.allowedTools).toEqual([]);
    expect(policy.decisions).toContainEqual({
      toolId: 'mcp__missing__publish',
      allowed: false,
      reason: 'unknown_tool',
    });
  });

  it('enforces action, workspace, and pipeline policy for protected WeChat tools', async () => {
    const manager = new McpManager();
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    (manager as any).clients.set('wechat-official-account', {
      config: { name: 'wechat-official-account' },
      isConnected: () => true,
      tools: [],
      serverInfo: {},
      callTool: async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return tool === 'wechat_draft'
          ? { content: [{ type: 'text', text: '草稿创建成功！\n草稿ID: draft-approved-12345\n包含文章数: 1' }] }
          : { content: 'ok' };
      },
      dispose: () => undefined,
    });
    const workdir = mkdtempSync(join(tmpdir(), 'wechat-policy-'));
    const outsideFile = join(mkdtempSync(join(tmpdir(), 'wechat-outside-')), 'secret.png');
    writeFileSync(outsideFile, 'not an image');

    await expect(manager.callTool(
      'mcp__wechat-official-account__wechat_draft',
      { action: 'add', articles: [] },
    )).rejects.toThrow(/governed agent execution context/);

    await expect(manager.callTool(
      'mcp__wechat-official-account__wechat_draft',
      { action: 'delete', mediaId: 'draft-id' },
      undefined,
      { agentId: 'wechat-writer', workdir },
    )).rejects.toThrow(/not allowed/);

    await expect(manager.callTool(
      'mcp__wechat-official-account__wechat_permanent_media',
      { action: 'add', type: 'image', filePath: outsideFile },
      undefined,
      { agentId: 'wechat-writer', workdir },
    )).rejects.toThrow(/inside the task workspace/);

    await expect(manager.callTool(
      'mcp__wechat-official-account__wechat_permanent_media',
      { action: 'add', type: 'image', filePath: 'generated-assets/cover.png' },
      undefined,
      { agentId: 'wechat-writer', workdir },
    )).rejects.toThrow(/absolute workspace file path/);

    await expect(manager.callTool(
      'mcp__wechat-official-account__wechat_publish',
      { action: 'submit', mediaId: 'draft-approved-12345' },
      undefined,
      { agentId: 'social-publisher', taskMode: 'direct', taskInput: 'draft-approved-12345' },
    )).rejects.toThrow(/approved .*pipeline stage/);

    await manager.callTool(
      'mcp__wechat-official-account__wechat_draft',
      { action: 'add', articles: [{ title: 'Test', content: 'Test', thumbMediaId: 'cover-id' }] },
      undefined,
      {
        agentId: 'wechat-writer',
        taskId: 'draft-task-1',
        taskMode: 'pipeline',
        pipelineId: 'pipeline-1',
        stageIndex: 4,
      },
    );
    const approvedWeChatContext = {
      agentId: 'social-publisher',
      taskMode: 'pipeline',
      pipelineId: 'pipeline-1',
      stageIndex: 5,
      taskId: 'publish-task-1',
      taskInput: 'Approved draft Media ID: draft-approved',
      publishAuthorized: true,
      approvedDraftTaskIds: ['draft-task-1'],
      approvedPublishTools: ['mcp__wechat-official-account__wechat_publish'],
      publishAuthorizationId: 'publish-task-1',
    };
    await expect(manager.callTool(
      'mcp__wechat-official-account__wechat_publish',
      { action: 'submit', mediaId: 'stale-draft-12345' },
      undefined,
      approvedWeChatContext,
    )).rejects.toThrow(/exactly match/);
    await manager.callTool(
      'mcp__wechat-official-account__wechat_publish',
      { action: 'submit', mediaId: 'draft-approved-12345' },
      undefined,
      approvedWeChatContext,
    );
    expect(calls).toEqual([
      {
        tool: 'wechat_draft',
        args: { action: 'add', articles: [{ title: 'Test', content: 'Test', thumbMediaId: 'cover-id' }] },
      },
      {
        tool: 'wechat_publish',
        args: { action: 'submit', mediaId: 'draft-approved-12345' },
      },
    ]);
    await expect(manager.callTool(
      'mcp__wechat-official-account__wechat_publish',
      { action: 'submit', mediaId: 'draft-approved-12345' },
      undefined,
      approvedWeChatContext,
    )).rejects.toThrow(/already used/);
    (manager as any).consumedPublishAuthorizations.clear();
    await expect(manager.callTool(
      'mcp__wechat-official-account__wechat_publish',
      { action: 'submit', mediaId: 'draft-approved-12345' },
      undefined,
      approvedWeChatContext,
    )).rejects.toThrow(/already used/);

    await expect(manager.callTool(
      'mcp__xiaohongshu__publish_content',
      { title: 'wrong-platform publish' },
      undefined,
      approvedWeChatContext,
    )).rejects.toThrow(/approved .*pipeline stage/);
    manager.dispose();
  });
});
