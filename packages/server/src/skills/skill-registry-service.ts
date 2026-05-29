import { createHash } from 'crypto';
import { getDb } from '../db/database.js';
import { parseSkillContent } from './skill-parser.js';
import { upsertSkill, createSkillVersion, publishSkillVersion } from '../db/models/skill.js';
import { logger } from '../lib/logger.js';
import { reviewImportedSkillContent } from './skill-review.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RegistrySource {
  id: string;
  name: string;
  type: 'github' | 'http' | 'local';
  url: string;
  branch: string;
  pathPrefix: string;
  authToken?: string;
  lastSyncedAt?: string;
  enabled: boolean;
  createdAt: string;
}

export interface CatalogEntry {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  path: string;
  contentHash?: string;
  tags: string[];
  isStructured: boolean;
  lastSyncedAt?: string;
  createdAt: string;
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────

function rowToSource(row: any): RegistrySource {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url,
    branch: row.branch || 'main',
    pathPrefix: row.path_prefix || '',
    authToken: row.auth_token || undefined,
    lastSyncedAt: row.last_synced_at || undefined,
    enabled: !!row.enabled,
    createdAt: row.created_at,
  };
}

function rowToCatalog(row: any): CatalogEntry {
  return {
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    description: row.description || '',
    path: row.path,
    contentHash: row.content_hash || undefined,
    tags: JSON.parse(row.tags || '[]'),
    isStructured: !!row.is_structured,
    lastSyncedAt: row.last_synced_at || undefined,
    createdAt: row.created_at,
  };
}

// ─── Source CRUD ─────────────────────────────────────────────────────────────

export function listSources(): RegistrySource[] {
  return getDb().all('SELECT * FROM skill_registry_sources ORDER BY name ASC').map(rowToSource);
}

export function getSource(id: string): RegistrySource | undefined {
  const row = getDb().get('SELECT * FROM skill_registry_sources WHERE id = ?', id);
  return row ? rowToSource(row) : undefined;
}

export function createSource(data: {
  id?: string;
  name: string;
  type: 'github' | 'http' | 'local';
  url: string;
  branch?: string;
  pathPrefix?: string;
  authToken?: string;
}): RegistrySource {
  const id = data.id || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  getDb().run(`
    INSERT INTO skill_registry_sources (id, name, type, url, branch, path_prefix, auth_token)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      url = excluded.url,
      branch = excluded.branch,
      path_prefix = excluded.path_prefix,
      auth_token = excluded.auth_token
  `, id, data.name, data.type, data.url, data.branch || 'main', data.pathPrefix || '', data.authToken || null);
  return getSource(id)!;
}

export function deleteSource(id: string): boolean {
  getDb().run('DELETE FROM skill_registry_catalog WHERE source_id = ?', id);
  const result = getDb().run('DELETE FROM skill_registry_sources WHERE id = ?', id);
  return result.changes > 0;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

export function browseCatalog(filter?: { sourceId?: string; search?: string; structured?: boolean }): CatalogEntry[] {
  let sql = 'SELECT * FROM skill_registry_catalog';
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter?.sourceId) { conditions.push('source_id = ?'); params.push(filter.sourceId); }
  if (filter?.structured !== undefined) { conditions.push('is_structured = ?'); params.push(filter.structured ? 1 : 0); }
  if (filter?.search) { conditions.push('(name LIKE ? OR description LIKE ?)'); params.push(`%${filter.search}%`, `%${filter.search}%`); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY name ASC';

  return getDb().all(sql, ...params).map(rowToCatalog);
}

// ─── Sync ────────────────────────────────────────────────────────────────────

export async function syncSource(sourceId: string): Promise<{ added: number; updated: number }> {
  const source = getSource(sourceId);
  if (!source) throw new Error(`Source ${sourceId} not found`);

  let files: { path: string; downloadUrl: string }[] = [];

  if (source.type === 'github') {
    files = await fetchGithubTree(source);
  } else if (source.type === 'http') {
    // HTTP sources serve a JSON index
    files = await fetchHttpIndex(source);
  } else {
    throw new Error(`Source type "${source.type}" sync not implemented`);
  }

  let added = 0, updated = 0;
  const now = new Date().toISOString();

  // Process files in parallel batches (concurrency = 5)
  const BATCH_SIZE = 5;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (file) => {
      const content = await fetchFileContent(file.downloadUrl, source.authToken);
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
      const catalogId = `${sourceId}:${file.path}`;

      const existing = getDb().get('SELECT content_hash FROM skill_registry_catalog WHERE id = ?', catalogId) as any;
      if (existing?.content_hash === hash) return 'unchanged' as const;

      const parsed = parseSkillContent(content);
      const nameFromContent = extractTitle(content, file.path);
      const description = extractDescription(content);
      const tags = extractTags(content, parsed);

      getDb().run(`
        INSERT INTO skill_registry_catalog (id, source_id, name, description, path, content_hash, tags, is_structured, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          content_hash = excluded.content_hash,
          tags = excluded.tags,
          is_structured = excluded.is_structured,
          last_synced_at = excluded.last_synced_at
      `, catalogId, sourceId, nameFromContent, description, file.path, hash, JSON.stringify(tags), parsed.isStructured ? 1 : 0, now);

      return existing ? 'updated' as const : 'added' as const;
    }));

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value === 'added') added++;
        else if (r.value === 'updated') updated++;
      } else {
        logger.warn({ err: r.reason?.message }, 'Failed to sync skill file');
      }
    }
  }

  // Update source last_synced_at
  getDb().run('UPDATE skill_registry_sources SET last_synced_at = ? WHERE id = ?', now, sourceId);

  return { added, updated };
}

// ─── Import ──────────────────────────────────────────────────────────────────

export async function importSkill(catalogId: string, options?: { transform?: boolean }): Promise<{ skillId: string; versionId: string }> {
  const entry = getDb().get('SELECT * FROM skill_registry_catalog WHERE id = ?', catalogId) as any;
  if (!entry) throw new Error(`Catalog entry ${catalogId} not found`);

  const source = getSource(entry.source_id);
  if (!source) throw new Error(`Source ${entry.source_id} not found`);

  // Fetch latest content
  const downloadUrl = buildDownloadUrl(source, entry.path);
  let content = await fetchFileContent(downloadUrl, source.authToken);

  // Optionally transform plain markdown into step-driven format via LLM
  const parsed = parseSkillContent(content);
  if (options?.transform && !parsed.isStructured) {
    content = await transformToStructured(content, entry.name);
  }

  const review = reviewImportedSkillContent(content);
  if (!review.approved) {
    throw new Error(`Imported skill failed safety review: ${review.issues.map(issue => `${issue.code}: ${issue.message}`).join('; ')}`);
  }

  // Create local skill
  const skillId = entry.path.replace(/\.md$/, '').replace(/[/\\]/g, '-');
  const skill = upsertSkill({
    id: skillId,
    name: entry.name,
    description: entry.description || `Imported from ${source.name}`,
    sourcePath: `registry:${catalogId}`,
  });

  const version = createSkillVersion({
    skillId: skill.id,
    content,
    status: 'published',
    changelog: [
      `Imported from ${source.name} (${entry.path})`,
      ...review.issues.map(issue => `Review ${issue.severity}: ${issue.message}`),
    ].join('\n'),
    createdBy: 'registry',
    publishedBy: 'registry',
  });

  return { skillId: skill.id, versionId: version.id };
}

// ─── GitHub Helpers ──────────────────────────────────────────────────────────

async function fetchGithubTree(source: RegistrySource): Promise<{ path: string; downloadUrl: string }[]> {
  // Parse owner/repo from URL
  const match = source.url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${source.url}`);
  const [, owner, repo] = match;

  const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  if (source.authToken) headers.Authorization = `token ${source.authToken}`;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${source.branch}?recursive=1`,
    { headers }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);

  const data = await res.json() as { tree: { path: string; type: string }[] };

  return data.tree
    .filter(item => item.type === 'blob' && item.path.endsWith('.md'))
    .filter(item => !source.pathPrefix || item.path.startsWith(source.pathPrefix))
    .map(item => ({
      path: source.pathPrefix ? item.path.slice(source.pathPrefix.length + 1) : item.path,
      downloadUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${source.branch}/${item.path}`,
    }));
}

async function fetchHttpIndex(source: RegistrySource): Promise<{ path: string; downloadUrl: string }[]> {
  const res = await fetch(source.url, {
    headers: source.authToken ? { Authorization: `Bearer ${source.authToken}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP index fetch failed: ${res.status}`);
  const data = await res.json() as { skills: { path: string; url: string }[] };
  return data.skills.map(s => ({ path: s.path, downloadUrl: s.url }));
}

async function fetchFileContent(url: string, authToken?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `token ${authToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
  return res.text();
}

function buildDownloadUrl(source: RegistrySource, path: string): string {
  if (source.type === 'github') {
    const match = source.url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return '';
    const [, owner, repo] = match;
    const fullPath = source.pathPrefix ? `${source.pathPrefix}/${path}` : path;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${source.branch}/${fullPath}`;
  }
  return `${source.url}/${path}`;
}

// ─── Content Parsing Helpers ─────────────────────────────────────────────────

function extractTitle(content: string, fallbackPath: string): string {
  const heading = content.split('\n').find(l => l.startsWith('# '));
  if (heading) return heading.replace(/^#\s+/, '').trim();
  return fallbackPath.replace(/\.md$/, '').split('/').pop() || fallbackPath;
}

function extractDescription(content: string): string {
  const lines = content.split('\n');
  const headingIdx = lines.findIndex(l => l.startsWith('# '));
  if (headingIdx === -1) return '';
  // First non-empty line after heading
  for (let i = headingIdx + 1; i < Math.min(headingIdx + 5, lines.length); i++) {
    if (lines[i].trim() && !lines[i].startsWith('#')) return lines[i].trim().slice(0, 200);
  }
  return '';
}

function extractTags(content: string, parsed: ReturnType<typeof parseSkillContent>): string[] {
  const tags: string[] = [];
  if (parsed.isStructured) {
    tags.push('step-driven');
    if (parsed.config?.trigger?.keywords) tags.push(...parsed.config.trigger.keywords.slice(0, 5));
  }
  if (content.toLowerCase().includes('tdd') || content.toLowerCase().includes('test-driven')) tags.push('tdd');
  if (content.toLowerCase().includes('debug')) tags.push('debug');
  if (content.toLowerCase().includes('review')) tags.push('review');
  return [...new Set(tags)].slice(0, 8);
}

// ─── LLM Transform ───────────────────────────────────────────────────────────

async function transformToStructured(content: string, skillName: string): Promise<string> {
  try {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      baseURL: process.env.CREWAI_BASE_URL || 'https://morninglab.japaneast.cloudapp.azure.com/v1',
      apiKey: process.env.CREWAI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    });

    const prompt = `You are a skill format converter. Given a markdown skill definition, generate YAML frontmatter that converts it into a step-driven executor format.

## Input Skill:
${content.slice(0, 3000)}

## Instructions:
1. Analyze the skill's purpose and workflow
2. Break it into 2-5 logical steps
3. For each step, define: name, instruction, tools (from: file_read, file_write, shell_exec, grep), maxTurns, and validation command
4. Output ONLY the complete file: YAML frontmatter (---...---) followed by the original markdown content
5. The validation commands should be simple shell checks (test -n, grep, exit codes)

Output the complete converted skill file:`;

    const response = await client.chat.completions.create({
      model: process.env.CREWAI_MODEL || 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 4096,
    });

    const result = response.choices[0]?.message?.content || '';
    // Validate it parses correctly
    const parsed = parseSkillContent(result);
    if (parsed.isStructured) return result;

    // If LLM output doesn't parse, return original
    logger.warn({ skillName }, 'LLM transform did not produce valid structured skill, using original');
    return content;
  } catch (err: any) {
    logger.warn({ skillName, err: err.message }, 'LLM transform failed, using original content');
    return content;
  }
}

// ─── Default Sources Seeding ─────────────────────────────────────────────────

export function seedDefaultSources(): void {
  const existing = listSources();
  if (existing.length > 0) return;

  createSource({
    id: 'superpowers-official',
    name: 'Superpowers (Official)',
    type: 'github',
    url: 'https://github.com/anthropics/claude-code-plugins',
    branch: 'main',
    pathPrefix: 'superpowers/skills',
  });
}

// ─── Auto-Sync Scheduler ─────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoSync(): void {
  if (autoSyncTimer) return;
  autoSyncTimer = setInterval(async () => {
    const sources = listSources().filter(s => s.enabled);
    for (const source of sources) {
      try {
        const result = await syncSource(source.id);
        if (result.added > 0 || result.updated > 0) {
          logger.info({ sourceId: source.id, ...result }, 'Auto-synced skill registry source');
        }
      } catch (err: any) {
        logger.warn({ sourceId: source.id, err: err.message }, 'Auto-sync failed for source');
      }
    }
  }, SYNC_INTERVAL_MS);
  autoSyncTimer.unref();
}

export function stopAutoSync(): void {
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
}
