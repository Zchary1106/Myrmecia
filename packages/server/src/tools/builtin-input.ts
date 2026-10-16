import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { BUILTIN_TOOLS } from './tool-registry.js';

// Compile only server-owned schemas. Never cache/execute an imported tool schema here.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const pathTools = new Set(['file_read', 'file_write', 'file_list', 'apply_patch']);
const guardedTools = new Set([...pathTools, 'shell_exec']);
const validators = new Map(BUILTIN_TOOLS.filter(tool => guardedTools.has(tool.id))
  .map(tool => [tool.id, ajv.compile(tool.inputSchema)]));

/** Validate before middleware reservations or sandbox effects; never coerce missing content to ''. */
export function builtinInputErrors(tool: string, input: unknown): string[] {
  const validate = validators.get(tool);
  if (!validate) return [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['Tool input must be a JSON object'];
  const normalized = { ...input } as Record<string, unknown>;
  // Preserve the existing documented legacy aliases without weakening read-before-write.
  const alias = pathTools.has(tool) ? ['path', 'file_path'] : tool === 'shell_exec' ? ['command', 'cmd'] : undefined;
  if (alias && normalized[alias[1]] !== undefined) {
    if (normalized[alias[0]] !== undefined && normalized[alias[0]] !== normalized[alias[1]]) {
      return [`Conflicting ${alias[0]} and ${alias[1]} parameters`];
    }
    normalized[alias[0]] ??= normalized[alias[1]];
  }
  if (pathTools.has(tool) && tool !== 'file_list' && typeof normalized.path === 'string' && !normalized.path.trim()) {
    return ['path must be a non-empty file path'];
  }
  if (validate(normalized)) return [];
  // Do not echo file contents, credentials or arbitrary argument values.
  return (validate.errors || []).slice(0, 8).map(error =>
    `${error.instancePath || 'input'} ${error.message}${error.keyword === 'required'
      ? `: ${String(error.params.missingProperty)}` : ''}`);
}
