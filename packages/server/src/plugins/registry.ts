/**
 * Plugin System — extensible platform capabilities
 *
 * Plugins can register:
 * - Custom tools (available to agents)
 * - Agent templates
 * - Pipeline nodes/stages
 * - Dashboard widgets (via manifest)
 *
 * Plugin lifecycle:
 * 1. Install (from registry URL or local path)
 * 2. Enable/Disable per workspace
 * 3. Version management and compatibility checks
 *
 * Plugin manifest format (manifest.json):
 * {
 *   "id": "plugin-id",
 *   "name": "Plugin Name",
 *   "version": "1.0.0",
 *   "description": "...",
 *   "author": "...",
 *   "minPlatformVersion": "0.1.0",
 *   "capabilities": ["tools", "agent_templates", "pipeline_nodes"],
 *   "entry": "./index.js",
 *   "tools": [...],
 *   "agentTemplates": [...],
 *   "permissions": ["network", "filesystem"]
 * }
 */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database.js';
import { logger } from '../lib/logger.js';
import { Router } from 'express';

// ---------- Types ----------

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  minPlatformVersion?: string;
  capabilities: PluginCapability[];
  entry: string;
  tools?: PluginToolDef[];
  agentTemplates?: PluginAgentTemplate[];
  permissions?: string[];
}

export type PluginCapability = 'tools' | 'agent_templates' | 'pipeline_nodes' | 'widgets';

export interface PluginToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PluginAgentTemplate {
  id: string;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
}

export type PluginStatus = 'installed' | 'enabled' | 'disabled' | 'error';

export interface InstalledPlugin {
  id: string;
  pluginId: string;
  manifest: PluginManifest;
  status: PluginStatus;
  workspaceId: string;
  installedAt: string;
  error?: string;
}

// ---------- Schema ----------

export const PLUGIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS installed_plugins (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  manifest JSON NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed' CHECK(status IN ('installed','enabled','disabled','error')),
  source_url TEXT,
  error TEXT,
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(plugin_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_plugins_workspace ON installed_plugins(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plugins_status ON installed_plugins(status);
`;

// ---------- Plugin Registry ----------

export class PluginRegistry {

  install(workspaceId: string, manifest: PluginManifest, sourceUrl?: string): InstalledPlugin {
    const db = getDb();
    const id = `plg_${uuid().slice(0, 8)}`;

    // Compatibility check
    const platformVersion = '0.1.0';
    if (manifest.minPlatformVersion && manifest.minPlatformVersion > platformVersion) {
      throw new Error(`Plugin requires platform v${manifest.minPlatformVersion}, current is v${platformVersion}`);
    }

    db.run(
      `INSERT INTO installed_plugins (id, plugin_id, workspace_id, manifest, source_url, status)
       VALUES (?, ?, ?, ?, ?, 'installed')
       ON CONFLICT(plugin_id, workspace_id) DO UPDATE SET manifest = ?, source_url = ?, status = 'installed', updated_at = CURRENT_TIMESTAMP`,
      id, manifest.id, workspaceId, JSON.stringify(manifest), sourceUrl || null,
      JSON.stringify(manifest), sourceUrl || null
    );

    logger.info({ pluginId: manifest.id, workspace: workspaceId }, 'Plugin installed');
    return this.get(workspaceId, manifest.id)!;
  }

  enable(workspaceId: string, pluginId: string): InstalledPlugin | undefined {
    const db = getDb();
    db.run(
      "UPDATE installed_plugins SET status = 'enabled', updated_at = CURRENT_TIMESTAMP WHERE plugin_id = ? AND workspace_id = ?",
      pluginId, workspaceId
    );
    return this.get(workspaceId, pluginId);
  }

  disable(workspaceId: string, pluginId: string): InstalledPlugin | undefined {
    const db = getDb();
    db.run(
      "UPDATE installed_plugins SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE plugin_id = ? AND workspace_id = ?",
      pluginId, workspaceId
    );
    return this.get(workspaceId, pluginId);
  }

  uninstall(workspaceId: string, pluginId: string): boolean {
    const db = getDb();
    const result = db.run('DELETE FROM installed_plugins WHERE plugin_id = ? AND workspace_id = ?', pluginId, workspaceId);
    return result.changes > 0;
  }

  get(workspaceId: string, pluginId: string): InstalledPlugin | undefined {
    const db = getDb();
    const row = db.get('SELECT * FROM installed_plugins WHERE plugin_id = ? AND workspace_id = ?', pluginId, workspaceId) as any;
    return row ? this.rowToPlugin(row) : undefined;
  }

  list(workspaceId: string, status?: PluginStatus): InstalledPlugin[] {
    const db = getDb();
    let sql = 'SELECT * FROM installed_plugins WHERE workspace_id = ?';
    const params: any[] = [workspaceId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY installed_at DESC';
    return db.all(sql, ...params).map((row: any) => this.rowToPlugin(row));
  }

  /** Get all enabled tools across all plugins for a workspace */
  getEnabledTools(workspaceId: string): PluginToolDef[] {
    const plugins = this.list(workspaceId, 'enabled');
    return plugins.flatMap(p => p.manifest.tools || []);
  }

  /** Get all enabled agent templates across all plugins */
  getAgentTemplates(workspaceId: string): PluginAgentTemplate[] {
    const plugins = this.list(workspaceId, 'enabled');
    return plugins.flatMap(p => p.manifest.agentTemplates || []);
  }

  private rowToPlugin(row: any): InstalledPlugin {
    return {
      id: row.id,
      pluginId: row.plugin_id,
      manifest: JSON.parse(row.manifest),
      status: row.status,
      workspaceId: row.workspace_id,
      installedAt: row.installed_at,
      error: row.error || undefined,
    };
  }
}

export const pluginRegistry = new PluginRegistry();

// ---------- Routes ----------

export function createPluginRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    const status = req.query.status as PluginStatus | undefined;
    res.json(pluginRegistry.list(workspaceId, status));
  });

  router.post('/install', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    const { manifest, sourceUrl } = req.body;
    if (!manifest?.id || !manifest?.name || !manifest?.version) {
      return res.status(400).json({ error: { message: 'Invalid manifest: id, name, version required' } });
    }
    try {
      const plugin = pluginRegistry.install(workspaceId, manifest, sourceUrl);
      res.status(201).json(plugin);
    } catch (err: any) {
      res.status(400).json({ error: { message: err.message } });
    }
  });

  router.post('/:pluginId/enable', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    const plugin = pluginRegistry.enable(workspaceId, req.params.pluginId);
    plugin ? res.json(plugin) : res.status(404).json({ error: { message: 'Plugin not found' } });
  });

  router.post('/:pluginId/disable', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    const plugin = pluginRegistry.disable(workspaceId, req.params.pluginId);
    plugin ? res.json(plugin) : res.status(404).json({ error: { message: 'Plugin not found' } });
  });

  router.delete('/:pluginId', (req, res) => {
    const workspaceId = (req as any).tenantContext?.workspaceId || 'default';
    const removed = pluginRegistry.uninstall(workspaceId, req.params.pluginId);
    removed ? res.json({ success: true }) : res.status(404).json({ error: { message: 'Plugin not found' } });
  });

  return router;
}
