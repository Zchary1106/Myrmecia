import { getDb } from '../db/database.js';
import type { ToolDefinition, ToolPermission, ToolRiskLevel } from '../types.js';
import type { ParamConstraints } from './param-constraints.js';

interface BuiltinToolDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  riskLevel: ToolRiskLevel;
  version: string;
  implementationRef: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  paramConstraints?: Record<string, Record<string, unknown>>;
}

export const BUILTIN_TOOLS: BuiltinToolDefinition[] = [
  {
    id: 'web.search',
    name: 'Web Search',
    description: 'Search the public web and return compact result titles and URLs.',
    category: 'research',
    riskLevel: 'medium',
    version: '1.0.0',
    implementationRef: 'packages/python-runtime/agent_tools.py:web_search',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1 } },
    },
    outputSchema: { type: 'array', items: { type: 'object' } },
    metadata: { network: true, readOnly: true, allowedDomains: ['*'], destructive: false, writesWorkspace: false, writesOutsideWorkspace: false },
  },
  {
    id: 'web.fetch',
    name: 'Web Fetch',
    description: 'Fetch an absolute http/https URL and return compact page text.',
    category: 'research',
    riskLevel: 'medium',
    version: '1.0.0',
    implementationRef: 'packages/python-runtime/agent_tools.py:web_fetch',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', format: 'uri' } },
    },
    outputSchema: { type: 'string' },
    metadata: { network: true, readOnly: true, maxBytes: 512000, allowedDomains: ['*'], destructive: false, writesWorkspace: false, writesOutsideWorkspace: false },
    paramConstraints: {
      url: {
        allowedDomains: ['*'], // open by default, customize per-agent
        pattern: '^https?://',
        maxLength: 2048,
      },
    },
  },
  {
    id: 'crawler.extract_links',
    name: 'Crawler Link Extractor',
    description: 'Fetch a page and extract visible links for lightweight crawling.',
    category: 'crawler',
    riskLevel: 'medium',
    version: '1.0.0',
    implementationRef: 'packages/python-runtime/agent_tools.py:crawler_extract_links',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', format: 'uri' } },
    },
    outputSchema: { type: 'array', items: { type: 'object' } },
    metadata: { network: true, readOnly: true, maxLinks: 50, allowedDomains: ['*'], destructive: false, writesWorkspace: false, writesOutsideWorkspace: false },
    paramConstraints: {
      url: {
        allowedDomains: ['*'],
        pattern: '^https?://',
        maxLength: 2048,
      },
    },
  },
  {
    id: 'browser.query',
    name: 'Browser Query',
    description: 'Drive a real headless browser (remote browser-use service) to complete a web task — navigate, click, read JS-rendered pages — and return the answer. Use when web.fetch is not enough.',
    category: 'research',
    riskLevel: 'medium',
    version: '1.0.0',
    implementationRef: 'packages/python-runtime/agent_tools.py:browser_query',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', minLength: 1 },
        allowed_domains: { type: 'string', description: 'Optional comma-separated hostname allowlist' },
        max_steps: { type: 'integer', minimum: 1, maximum: 60 },
      },
    },
    outputSchema: { type: 'object' },
    metadata: { network: true, readOnly: true, allowedDomains: ['*'], destructive: false, writesWorkspace: false, writesOutsideWorkspace: false },
  },
  {
    id: 'content.wechat_layout',
    name: 'WeChat Layout',
    description: 'Convert a WeChat article draft into layout recommendations and HTML blocks.',
    category: 'content',
    riskLevel: 'low',
    version: '1.0.0',
    implementationRef: 'packages/python-runtime/agent_tools.py:content_wechat_layout',
    inputSchema: {
      type: 'object',
      required: ['markdown'],
      properties: { markdown: { type: 'string', minLength: 1 } },
    },
    outputSchema: { type: 'object' },
    metadata: { readOnly: true, network: false, destructive: false, writesWorkspace: false, writesOutsideWorkspace: false },
  },
  {
    id: 'content.hashtag_plan',
    name: 'Hashtag Plan',
    description: 'Generate platform-specific hashtags and keyword clusters for Chinese content.',
    category: 'content',
    riskLevel: 'low',
    version: '1.0.0',
    implementationRef: 'packages/python-runtime/agent_tools.py:content_hashtag_plan',
    inputSchema: {
      type: 'object',
      required: ['topic'],
      properties: { topic: { type: 'string', minLength: 1 } },
    },
    outputSchema: { type: 'object' },
    metadata: { readOnly: true, network: false, destructive: false, writesWorkspace: false, writesOutsideWorkspace: false },
  },
  {
    id: 'image.generate_svg',
    name: 'SVG Image Generator',
    description: 'Generate a simple SVG cover image asset in the task workspace.',
    category: 'asset',
    riskLevel: 'medium',
    version: '1.0.0',
    implementationRef: 'packages/python-runtime/agent_tools.py:image_generate_svg',
    inputSchema: {
      type: 'object',
      required: ['spec'],
      properties: { spec: { type: 'string', minLength: 1 } },
    },
    outputSchema: { type: 'object' },
    metadata: { readOnly: false, network: false, writesWorkspace: true, writesOutsideWorkspace: false, destructive: false, outputFormat: 'svg' },
  },

  // ---- engineering tools (sandboxed, confined to the task workspace) ----
  {
    id: 'file_read',
    name: 'File Read',
    description: 'Read a UTF-8 file from the task workspace.',
    category: 'engineering',
    riskLevel: 'low',
    version: '1.0.0',
    implementationRef: 'packages/server/src/skills/tool-sandbox.ts:executeTool',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } },
    outputSchema: { type: 'string' },
    metadata: { readOnly: true, network: false, writesWorkspace: false, writesOutsideWorkspace: false, destructive: false },
  },
  {
    id: 'file_list',
    name: 'File List',
    description: 'List files and directories in the task workspace (recursive, capped).',
    category: 'engineering',
    riskLevel: 'low',
    version: '1.0.0',
    implementationRef: 'packages/server/src/skills/tool-sandbox.ts:executeTool',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    outputSchema: { type: 'string' },
    metadata: { readOnly: true, network: false, writesWorkspace: false, writesOutsideWorkspace: false, destructive: false },
  },
  {
    id: 'grep',
    name: 'Workspace Grep',
    description: 'Search workspace text files for a pattern.',
    category: 'engineering',
    riskLevel: 'low',
    version: '1.0.0',
    implementationRef: 'packages/server/src/skills/tool-sandbox.ts:executeTool',
    inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string', minLength: 1 }, glob: { type: 'string' } } },
    outputSchema: { type: 'string' },
    metadata: { readOnly: true, network: false, writesWorkspace: false, writesOutsideWorkspace: false, destructive: false },
  },
  {
    id: 'file_write',
    name: 'File Write',
    description: 'Create or overwrite a UTF-8 file inside the task workspace.',
    category: 'engineering',
    riskLevel: 'medium',
    version: '1.0.0',
    implementationRef: 'packages/server/src/skills/tool-sandbox.ts:executeTool',
    inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } } },
    outputSchema: { type: 'string' },
    metadata: { readOnly: false, network: false, writesWorkspace: true, writesOutsideWorkspace: false, destructive: false },
  },
  {
    id: 'apply_patch',
    name: 'Apply Patch',
    description: 'Surgical edit: replace one exact occurrence of old_str with new_str in a workspace file.',
    category: 'engineering',
    riskLevel: 'medium',
    version: '1.0.0',
    implementationRef: 'packages/server/src/skills/tool-sandbox.ts:executeTool',
    inputSchema: {
      type: 'object',
      required: ['path', 'old_str', 'new_str'],
      properties: { path: { type: 'string', minLength: 1 }, old_str: { type: 'string', minLength: 1 }, new_str: { type: 'string' } },
    },
    outputSchema: { type: 'string' },
    metadata: { readOnly: false, network: false, writesWorkspace: true, writesOutsideWorkspace: false, destructive: false },
  },
  {
    id: 'shell_exec',
    name: 'Shell Exec',
    description: 'Run a shell command in the task workspace (guardrailed, timed out, output capped).',
    category: 'engineering',
    riskLevel: 'high',
    version: '1.0.0',
    implementationRef: 'packages/server/src/skills/tool-sandbox.ts:executeTool',
    inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string', minLength: 1 } } },
    outputSchema: { type: 'string' },
    metadata: { readOnly: false, network: false, writesWorkspace: true, writesOutsideWorkspace: false, destructive: true },
  },
];

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function rowToTool(row: any): ToolDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    category: row.category,
    riskLevel: row.risk_level,
    enabled: Boolean(row.enabled),
    approvalRequired: Boolean(row.approval_required),
    inputSchema: parseJsonObject(row.input_schema),
    outputSchema: parseJsonObject(row.output_schema),
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPermission(row: any): ToolPermission {
  return {
    toolId: row.tool_id,
    agentId: row.agent_id,
    enabled: Boolean(row.enabled),
    approvalRequired: row.approval_required === null || row.approval_required === undefined
      ? undefined
      : Boolean(row.approval_required),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function syncBuiltinTools(): void {
  const db = getDb();
  db.transaction(() => {
    for (const tool of BUILTIN_TOOLS) {
      db.run(`
        INSERT INTO tools (
          id, name, description, category, risk_level, input_schema, output_schema, metadata
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          category = excluded.category,
          risk_level = excluded.risk_level,
          input_schema = excluded.input_schema,
          output_schema = excluded.output_schema,
          metadata = excluded.metadata,
          updated_at = CURRENT_TIMESTAMP
      `,
        tool.id,
        tool.name,
        tool.description,
        tool.category,
        tool.riskLevel,
        JSON.stringify(tool.inputSchema),
        JSON.stringify(tool.outputSchema || {}),
        JSON.stringify({
          ...(tool.metadata || {}),
          ...(tool.paramConstraints ? { paramConstraints: tool.paramConstraints } : {}),
        }),
      );

      db.run(`
        INSERT INTO tool_versions (
          id, tool_id, version, description, input_schema, output_schema, implementation_ref, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(tool_id, version) DO UPDATE SET
          description = excluded.description,
          input_schema = excluded.input_schema,
          output_schema = excluded.output_schema,
          implementation_ref = excluded.implementation_ref,
          status = 'active'
      `,
        `${tool.id}@${tool.version}`,
        tool.id,
        tool.version,
        tool.description,
        JSON.stringify(tool.inputSchema),
        JSON.stringify(tool.outputSchema || {}),
        tool.implementationRef,
      );
    }
  });
}

export function listTools(filter?: { enabled?: boolean; category?: string }): ToolDefinition[] {
  const db = getDb();
  let sql = 'SELECT * FROM tools';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.enabled !== undefined) {
    conditions.push('enabled = ?');
    params.push(filter.enabled ? 1 : 0);
  }
  if (filter?.category) {
    conditions.push('category = ?');
    params.push(filter.category);
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY category ASC, id ASC';

  return (db.all(sql, ...params) as any[]).map(rowToTool);
}

export function getTool(id: string): ToolDefinition | undefined {
  const row = getDb().get('SELECT * FROM tools WHERE id = ?', id) as any;
  return row ? rowToTool(row) : undefined;
}

export function updateToolPolicy(id: string, updates: Partial<Pick<ToolDefinition, 'enabled' | 'approvalRequired'>>): ToolDefinition | undefined {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }
  if (updates.approvalRequired !== undefined) {
    sets.push('approval_required = ?');
    params.push(updates.approvalRequired ? 1 : 0);
  }
  if (sets.length === 0) return getTool(id);

  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  db.run(`UPDATE tools SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getTool(id);
}

export function listToolPermissions(filter?: { agentId?: string; toolId?: string }): ToolPermission[] {
  const db = getDb();
  let sql = 'SELECT * FROM tool_permissions';
  const params: any[] = [];
  const conditions: string[] = [];

  if (filter?.agentId) {
    conditions.push('agent_id = ?');
    params.push(filter.agentId);
  }
  if (filter?.toolId) {
    conditions.push('tool_id = ?');
    params.push(filter.toolId);
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY tool_id ASC, agent_id ASC';

  return (db.all(sql, ...params) as any[]).map(rowToPermission);
}

export function setToolPermission(data: {
  toolId: string;
  agentId: string;
  enabled: boolean;
  approvalRequired?: boolean;
}): ToolPermission {
  const db = getDb();
  db.run(`
    INSERT INTO tool_permissions (tool_id, agent_id, enabled, approval_required)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tool_id, agent_id) DO UPDATE SET
      enabled = excluded.enabled,
      approval_required = excluded.approval_required,
      updated_at = CURRENT_TIMESTAMP
  `,
    data.toolId,
    data.agentId,
    data.enabled ? 1 : 0,
    data.approvalRequired === undefined ? null : (data.approvalRequired ? 1 : 0),
  );
  return listToolPermissions({ toolId: data.toolId, agentId: data.agentId })[0];
}

/** Get parameter constraints for a tool from its metadata */
export function getToolParamConstraints(toolId: string): ParamConstraints {
  const tool = getTool(toolId);
  if (!tool?.metadata) return {};

  const constraints = tool.metadata.paramConstraints;
  if (constraints && typeof constraints === 'object' && !Array.isArray(constraints)) {
    return constraints as unknown as ParamConstraints;
  }
  return {};
}
