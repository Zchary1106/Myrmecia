/**
 * Legacy Agent Alias — resolver + deprecation API surface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createAgentRoutes } from '../src/routes/agents.js';
import {
  isLegacyAgent,
  listLegacyAliases,
  loadLegacyAgentAliases,
  resolveLegacyAgentId,
} from '../src/agents/legacy-agent-alias-resolver.js';

async function withApp<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind test server');
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function jsonFetch(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() as any };
}

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'legacy-alias-')), 'test.db');
  getDb();
  loadLegacyAgentAliases();
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

describe('LegacyAgentAliasResolver', () => {
  it('loads the built-in alias file and resolves a legacy id', () => {
    const alias = resolveLegacyAgentId('xiaohongshu-writer');
    expect(alias).toBeDefined();
    expect(alias?.agentId).toBe('content-creator');
    expect(alias?.skills).toEqual(expect.arrayContaining(['xiaohongshu-copywriting', 'hashtag-planning']));
  });

  it('covers all 18 legacy task agents from the migration matrix', () => {
    expect(listLegacyAliases()).toHaveLength(18);
    const ids = listLegacyAliases().map(entry => entry.legacyAgentId);
    for (const expected of [
      'wechat-writer', 'xiaohongshu-writer', 'xiaohongshu-visual-designer', 'douyin-writer',
      'trend-scout', 'content-strategist', 'i18n', 'db-migration', 'api-design', 'doc-writer',
      'release-notes-writer', 'social-compliance-reviewer', 'social-review-coordinator',
      'media-qa', 'social-preflight', 'social-publisher', 'social-ops', 'social-analytics',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('reports deprecation for legacy ids only', () => {
    expect(isLegacyAgent('xiaohongshu-writer')).toBe(true);
    expect(isLegacyAgent('dev')).toBe(false);
    expect(resolveLegacyAgentId('dev')).toBeUndefined();
  });

  it('maps social-publisher to ops with the publishing tool', () => {
    const alias = resolveLegacyAgentId('social-publisher');
    expect(alias?.agentId).toBe('ops');
    expect(alias?.tools).toEqual([
      'mcp__xiaohongshu__publish_content',
      'mcp__xiaohongshu__publish_with_video',
      'mcp__douyin-upload__douyin_upload_video',
      'mcp__wechat-official-account__wechat_publish',
    ]);
  });

  it('supports an explicit fixture path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'legacy-alias-fixture-'));
    const path = join(directory, 'legacy-agent-aliases.yaml');
    writeFileSync(path, [
      'legacyAgentAliases:',
      '  old-writer:',
      '    agentId: content-creator',
      '    skills: [custom-copywriting]',
    ].join('\n'));
    const aliases = loadLegacyAgentAliases(path);
    expect(aliases.get('old-writer')?.skills).toEqual(['custom-copywriting']);
  });
});

describe('Agent routes legacy annotation', () => {
  it('annotates deprecated agents with replacement info', async () => {
    createAgent({ id: 'xiaohongshu-writer', name: '小红书写手', role: 'content-writer', capabilities: ['copywriting'] });
    createAgent({ id: 'dev', name: 'Dev', role: 'developer', capabilities: ['typescript'] });

    const app = express();
    app.use('/agents', createAgentRoutes());

    await withApp(app, async baseUrl => {
      const list = await jsonFetch(baseUrl, '/agents');
      const legacyAgent = list.body.find((a: any) => a.id === 'xiaohongshu-writer');
      expect(legacyAgent.legacy).toEqual({
        deprecated: true,
        replacement: {
          agentId: 'content-creator',
          skills: ['xiaohongshu-copywriting', 'hashtag-planning'],
          tools: [],
        },
      });
      const stableAgent = list.body.find((a: any) => a.id === 'dev');
      expect(stableAgent.legacy).toBeUndefined();
    });
  });

  it('serves the legacy alias list and per-id deprecation status', async () => {
    const app = express();
    app.use('/agents', createAgentRoutes());

    await withApp(app, async baseUrl => {
      const aliases = await jsonFetch(baseUrl, '/agents/legacy');
      expect(aliases.body.aliases.length).toBe(18);

      const deprecated = await jsonFetch(baseUrl, '/agents/xiaohongshu-writer/deprecation');
      expect(deprecated.body.deprecated).toBe(true);
      expect(deprecated.body.legacy.replacement.agentId).toBe('content-creator');

      const stable = await jsonFetch(baseUrl, '/agents/dev/deprecation');
      expect(stable.body.deprecated).toBe(false);
    });
  });

  it('hides legacy agents when the flag is on, with includeLegacy override', async () => {
    process.env.MYRMECIA_HIDE_LEGACY_AGENTS = 'true';
    try {
      createAgent({ id: 'xiaohongshu-writer', name: '小红书写手', role: 'content-writer', capabilities: ['copywriting'] });
      createAgent({ id: 'dev', name: 'Dev', role: 'developer', capabilities: ['typescript'] });

      const app = express();
      app.use('/agents', createAgentRoutes());

      await withApp(app, async baseUrl => {
        const list = await jsonFetch(baseUrl, '/agents');
        expect(list.body.some((a: any) => a.id === 'xiaohongshu-writer')).toBe(false);
        expect(list.body.some((a: any) => a.id === 'dev')).toBe(true);

        const withLegacy = await jsonFetch(baseUrl, '/agents?includeLegacy=true');
        expect(withLegacy.body.some((a: any) => a.id === 'xiaohongshu-writer')).toBe(true);
      });
    } finally {
      delete process.env.MYRMECIA_HIDE_LEGACY_AGENTS;
    }
  });
});
