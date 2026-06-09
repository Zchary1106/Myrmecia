/**
 * Bridge MCP tools into the agent tool-calling loop.
 *
 * Produces OpenAI function definitions for all connected MCP tools and routes
 * `mcp__server__tool` calls to the MCP manager, flattening the result into a
 * string the model can consume.
 */

import { getMcpManager } from './mcp-manager.js';

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
export function getMcpToolDefinitions(): { defs: ModelToolDef[]; nameToQualified: Map<string, string> } {
  const nameToQualified = new Map<string, string>();
  const defs: ModelToolDef[] = [];
  if (!mcpToolsEnabled()) return { defs, nameToQualified };

  for (const tool of getMcpManager().listTools()) {
    const modelName = sanitizeToolName(tool.qualifiedName);
    nameToQualified.set(modelName, tool.qualifiedName);
    const parameters = isObjectSchema(tool.inputSchema)
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };
    defs.push({
      type: 'function',
      function: {
        name: modelName,
        description: tool.description || `MCP tool ${tool.name} from ${tool.server}`,
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
  timeoutMs?: number
): Promise<{ output: string; status: 'done' | 'failed' }> {
  try {
    const result = await getMcpManager().callTool(qualifiedName, args || {});
    return { output: mcpResultToString(result.content), status: result.isError ? 'failed' : 'done' };
  } catch (err: any) {
    return { output: err?.message || 'MCP tool failed', status: 'failed' };
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
