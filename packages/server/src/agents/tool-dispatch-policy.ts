import { resolve } from 'node:path';
import type { RuntimeToolCall } from '@myrmecia/shared';
import { BUILTIN_TOOLS } from '../tools/tool-registry.js';
import { classifyToolEffect, type ToolClassification } from './core/tool-scheduler.js';
import { XHS_READ_TOOLS } from '../tools/xiaohongshu-read-adapter.js';

/** Only source-controlled metadata is allowed to enable parallel reads. User edits stay unknown. */
export function classifyRuntimeTool(call: RuntimeToolCall, workdir: string): ToolClassification {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(call.arguments);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  } catch { throw new Error('MODEL_TOOL_ARGUMENTS_INVALID'); }
  const mcp = /^mcp__(.+?)__/.exec(call.name);
  const builtin = BUILTIN_TOOLS.find(tool => tool.id === call.name);
  const effect = XHS_READ_TOOLS.has(call.name) || call.name === 'mcp__xiaohongshu__check_login_status' ? 'read' : classifyToolEffect(builtin && call.name !== 'bash' && call.name !== 'shell'
    ? { trusted: true, readOnly: builtin.metadata?.readOnly === true,
      writes: builtin.metadata?.writesWorkspace === true || builtin.metadata?.writesOutsideWorkspace === true,
      destructive: builtin.metadata?.destructive === true } : undefined);
  return { effect, resources: typeof input.path === 'string' ? [`path:${resolve(workdir, input.path)}`] : [],
    serverKey: mcp?.[1], serverConcurrency: 1,
    basis: builtin ? 'source-controlled built-in metadata + validated arguments'
      : effect === 'read' ? 'source-controlled Xiaohongshu read adapter allowlist; server serialized'
        : mcp ? 'unknown MCP effect; server serialized' : 'untrusted/unknown effect' };
}

export function configuredReadConcurrency(): number {
  const value = Number(process.env.MYRMECIA_TOOL_READ_CONCURRENCY || 1);
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error('TOOL_CONCURRENCY_INVALID');
  return value;
}
