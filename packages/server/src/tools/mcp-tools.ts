/**
 * Bridge MCP tools into the agent tool-calling loop.
 *
 * Produces OpenAI function definitions for all connected MCP tools and routes
 * `mcp__server__tool` calls to the MCP manager, flattening the result into a
 * string the model can consume.
 */

import { getMcpManager, type McpCallPolicyContext } from './mcp-manager.js';
import { XHS_READ_TOOLS, xiaohongshuReadAdapter, xiaohongshuReadSchema } from './xiaohongshu-read-adapter.js';
import { xiaohongshuSession } from './xiaohongshu-session.js';
import type { XiaohongshuDiagnostics, XiaohongshuProgress } from './xiaohongshu-session.js';
import type { ToolFailure } from '@myrmecia/shared';
import { classifyToolFailure } from './tool-failure.js';

export interface ModelToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** Whether MCP tools should be surfaced to agents (default on). */
export function mcpToolsEnabled(): boolean {
  return process.env.MCP_TOOLS_IN_AGENTS !== 'false';
}

/**
 * Build function definitions for every connected MCP tool.
 * Returns the defs plus a map of model-tool-name → qualified MCP name.
 */
export function getMcpToolDefinitions(
  allowedTools?: ReadonlySet<string>,
): { defs: ModelToolDef[]; nameToQualified: Map<string, string> } {
  const nameToQualified = new Map<string, string>();
  const defs: ModelToolDef[] = [];
  if (!mcpToolsEnabled()) return { defs, nameToQualified };

  for (const tool of getMcpManager().listTools()) {
    if (allowedTools && !allowedTools.has(tool.qualifiedName)) continue;
    const modelName = sanitizeToolName(tool.qualifiedName);
    nameToQualified.set(modelName, tool.qualifiedName);
    const parameters = XHS_READ_TOOLS.has(tool.qualifiedName)
      ? xiaohongshuReadSchema(tool.qualifiedName)
      : isObjectSchema(tool.inputSchema)
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };
    defs.push({
      type: 'function',
      function: {
        name: modelName,
        description: XHS_READ_TOOLS.has(tool.qualifiedName)
          ? `Read-only Xiaohongshu ${tool.name}. Authentication is checked automatically. Search sequentially, at most three queries, then synthesize available evidence. Search returns note_ref for details, never tokens. Stop after login failure or timeout; do not claim unverified data.`
          : tool.description || `MCP tool ${tool.name} from ${tool.server}`,
        parameters,
      },
    });
  }
  return { defs, nameToQualified };
}

/** Execute an MCP tool by qualified name, returning loop-friendly output. */
export async function executeMcpTool(
  qualifiedName: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
  policyContext?: McpCallPolicyContext,
  onProgress?: XiaohongshuProgress,
  signal?: AbortSignal,
): Promise<{ output: string; status: 'done' | 'failed'; diagnostics?: XiaohongshuDiagnostics; failure?: ToolFailure }> {
  if (signal?.aborted) throw new Error('Request aborted');
  if (XHS_READ_TOOLS.has(qualifiedName)) {
    if (!policyContext?.taskId) return { status: 'failed', output: 'Xiaohongshu reads require a task-scoped Agent context.' };
    const result = await xiaohongshuSession.agentRead(qualifiedName, (remaining, report) => xiaohongshuReadAdapter.execute(
      qualifiedName, args,
      policyContext?.taskId ? JSON.stringify([policyContext.agentId, policyContext.taskId]) : undefined,
      (input, limit) => signal
        ? getMcpManager().callTool(qualifiedName, input, limit, policyContext, signal)
        : getMcpManager().callTool(qualifiedName, input, limit, policyContext),
      remaining,
      event => report(event.phase, event.message),
    ), timeoutMs, onProgress);
    return { ...result, ...(result.status === 'failed' ? { failure: classifyToolFailure(result.output, true) } : {}) };
  }
  try {
    const result = signal
      ? await getMcpManager().callTool(qualifiedName, args || {}, timeoutMs, policyContext, signal)
      : await getMcpManager().callTool(qualifiedName, args || {}, timeoutMs, policyContext);
    const output = mcpResultToString(result.content);
    return { output, status: result.isError ? 'failed' : 'done', ...(result.isError ? { failure: classifyToolFailure(output) } : {}) };
  } catch (err: any) {
    const output = err?.message || 'MCP tool failed';
    return { output, status: 'failed', failure: classifyToolFailure(output) };
  }
}

/** Flatten an MCP tools/call result into a plain string. */
export function mcpResultToString(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (block == null) return '';
        if (typeof block === 'string') return block;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return JSON.stringify(block);
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(content);
}

function isObjectSchema(schema: unknown): boolean {
  return !!schema && typeof schema === 'object' && (schema as any).type === 'object';
}

/** OpenAI function names must match ^[a-zA-Z0-9_-]{1,64}$. */
function sanitizeToolName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean.length <= 64 ? clean : clean.slice(0, 64);
}
