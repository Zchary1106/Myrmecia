import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { XHS_READ_TOOLS, XiaohongshuReadAdapter, xiaohongshuReadSchema } from '../src/tools/xiaohongshu-read-adapter.js';
import { executeMcpTool, getMcpToolDefinitions } from '../src/tools/mcp-tools.js';
import { getMcpManager } from '../src/tools/mcp-manager.js';
import { scanForPII } from '../src/security/dlp.js';
import { McpClient } from '../src/tools/mcp-client.js';

const prefix = 'mcp__xiaohongshu__';
const secret = 'tokenabcdefghijklmnopqrstuvw123456';
const response = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const searchResult = response({ feeds: [{
  id: 'abc123', xsecToken: secret,
  noteCard: { displayTitle: '水屋价格对比', user: { nickname: '旅行作者' }, interactInfo: { likedCount: '12' }, cover: { url: `https://example.com/?xsec_token=${secret}` } },
}] });

afterEach(() => vi.restoreAllMocks());

describe('Xiaohongshu read-only Agent adapter', () => {
  it('replaces secrets with scoped references and reconstructs detail arguments only in the tool layer', async () => {
    const adapter = new XiaohongshuReadAdapter();
    const search = vi.fn().mockResolvedValue(searchResult);
    const result = await adapter.execute(`${prefix}search_feeds`, { keyword: '水屋', xsec_token: 'untrusted' }, 'task-a', search);
    expect(result.status).toBe('done');
    expect(search).toHaveBeenCalledWith({ keyword: '水屋' }, 55_000);
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain('xsecToken');
    expect(scanForPII(result.output).clean).toBe(true);
    const note = JSON.parse(result.output).notes[0];
    expect(note.title).toBe('水屋价格对比');
    expect(note.source_url).toBe('https://www.xiaohongshu.com/explore/abc123');
    const detail = vi.fn().mockResolvedValue(response({
      note: { title: 'Details', desc: `A claim. ${secret}`, xsec_token: secret, imageList: ['private image'] },
    }));
    const fetched = await adapter.execute(`${prefix}get_feed_detail`, { note_ref: note.note_ref, load_all_comments: true }, 'task-a', detail);
    expect(detail).toHaveBeenCalledWith({ feed_id: 'abc123', xsec_token: secret, load_all_comments: false }, 45_000);
    expect(fetched.output).not.toContain(secret);
    expect(fetched.output).not.toContain('private image');
    expect(fetched.output).toContain('A claim.');
    expect(fetched.output).toContain('https://www.xiaohongshu.com/explore/abc123');
    expect(scanForPII(fetched.output).clean).toBe(true);
  });

  it('rejects cross-task, expired and restart-lost references without invoking MCP', async () => {
    let now = 1;
    const adapter = new XiaohongshuReadAdapter(() => now);
    const result = await adapter.execute(`${prefix}search_feeds`, { keyword: '水屋' }, 'a', vi.fn().mockResolvedValue(searchResult));
    const args = { note_ref: JSON.parse(result.output).notes[0].note_ref };
    const call = vi.fn();
    expect((await adapter.execute(`${prefix}get_feed_detail`, args, 'b', call)).status).toBe('failed');
    now += 15 * 60_000;
    expect((await adapter.execute(`${prefix}get_feed_detail`, args, 'a', call)).status).toBe('failed');
    expect((await new XiaohongshuReadAdapter().execute(`${prefix}get_feed_detail`, args, 'a', call)).status).toBe('failed');
    expect(call).not.toHaveBeenCalled();
  });

  it('treats upstream not-logged-in text as failure even when isError is false', async () => {
    const result = await new XiaohongshuReadAdapter().execute(`${prefix}check_login_status`, {}, 'a',
      vi.fn().mockResolvedValue({ isError: false, content: [{ type: 'text', text: '❌ 未登录\n请使用 get_login_qrcode 工具获取二维码进行登录。' }] }));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('not logged in');
  });

  it('recognizes real login success and honors a smaller caller budget', async () => {
    const call = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '✅ 已登录' }] });
    const result = await new XiaohongshuReadAdapter().execute(`${prefix}check_login_status`, {}, 'a', call, 1200);
    expect(result.status).toBe('done');
    expect(call).toHaveBeenCalledWith({}, 1200);
  });

  it('does not leak tokens from upstream transport errors or malformed responses', async () => {
    const adapter = new XiaohongshuReadAdapter();
    const failed = await adapter.execute(`${prefix}search_feeds`, { keyword: 'x' }, 'a', vi.fn().mockRejectedValue(new Error(secret)));
    const malformed = await adapter.execute(`${prefix}search_feeds`, { keyword: 'x' }, 'a', vi.fn().mockResolvedValue({ content: secret }));
    expect(failed.status).toBe('failed');
    expect(malformed.status).toBe('failed');
    expect(failed.output + malformed.output).not.toContain(secret);
  });

  it('distinguishes an upstream security challenge from a generic timeout', async () => {
    const progress: string[] = [];
    const result = await new XiaohongshuReadAdapter().execute(
      `${prefix}search_feeds`,
      { keyword: '水屋' },
      'a',
      vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '访问频繁，请完成安全验证' }] }),
      undefined,
      event => progress.push(event.phase),
    );
    expect(result.status).toBe('failed');
    expect(result.output).toContain('XHS_CHALLENGE');
    expect(progress).toEqual(['requesting_search', 'parsing_response']);
  });

  it('uses operation-specific budgets and reports parse progress', async () => {
    const progress: string[] = [];
    const call = vi.fn().mockResolvedValue(searchResult);
    const result = await new XiaohongshuReadAdapter().execute(
      `${prefix}search_feeds`, { keyword: '水屋' }, 'a', call, 60_000,
      event => progress.push(event.phase),
    );
    expect(result.status).toBe('done');
    expect(call).toHaveBeenCalledWith({ keyword: '水屋' }, 55_000);
    expect(progress).toEqual(['requesting_search', 'parsing_response']);
  });

  it('bounds result count and reports omission instead of silent truncation', async () => {
    const feeds = Array.from({ length: 20 }, (_, i) => ({ id: `note${i}`, xsecToken: secret, noteCard: { displayTitle: `Note ${i}` } }));
    const result = await new XiaohongshuReadAdapter().execute(`${prefix}search_feeds`, { keyword: 'x' }, 'a', vi.fn().mockResolvedValue(response({ feeds })));
    expect(JSON.parse(result.output).notes).toHaveLength(12);
    expect(JSON.parse(result.output).omitted).toBe(8);
  });

  it('rejects missing context and concurrent browser reads', async () => {
    const adapter = new XiaohongshuReadAdapter();
    const call = vi.fn();
    expect((await adapter.execute(`${prefix}search_feeds`, { keyword: 'x' }, undefined, call)).status).toBe('failed');
    expect(call).not.toHaveBeenCalled();
    let finish!: (value: typeof searchResult) => void;
    const pending = adapter.execute(`${prefix}search_feeds`, { keyword: 'x' }, 'a', () => new Promise(resolve => { finish = resolve; }));
    expect((await adapter.execute(`${prefix}search_feeds`, { keyword: 'x' }, 'b', call)).output).toContain('busy');
    finish(searchResult);
    await pending;
  });

  it('publishes only token-free read schemas to the model and sanitizes through the real bridge', async () => {
    vi.spyOn(getMcpManager(), 'listTools').mockReturnValue([...XHS_READ_TOOLS].map(qualifiedName => ({
      qualifiedName, server: 'xiaohongshu', name: qualifiedName.split('__')[2],
      inputSchema: { type: 'object', properties: { xsec_token: { type: 'string' } }, required: ['xsec_token'] },
    })));
    const defs = getMcpToolDefinitions(XHS_READ_TOOLS);
    expect(JSON.stringify(defs.defs)).not.toContain('xsec_token');
    expect(defs.defs).toHaveLength(3);
    expect(xiaohongshuReadSchema(`${prefix}get_feed_detail`).required).toEqual(['note_ref']);
    vi.spyOn(getMcpManager(), 'callTool').mockImplementation(async name => name.endsWith('check_login_status')
      ? { content: [{ type: 'text', text: '✅ 已登录' }] } : searchResult);
    const result = await executeMcpTool(`${prefix}search_feeds`, { keyword: 'test' }, 3000, { taskId: 'bridge-task', agentId: 'xiaohongshu-writer' });
    expect(result.status).toBe('done');
    expect(result.output).not.toContain(secret);
  });

  it('grants writer reads without publishing, social interactions or cookie mutations', () => {
    const registry = YAML.parse(readFileSync(new URL('../../../agents/registry.yaml', import.meta.url), 'utf8'));
    const agents = Array.isArray(registry) ? registry : registry.agents;
    const writer = agents.find((agent: { id: string }) => agent.id === 'xiaohongshu-writer');
    expect(writer.allowed_tools.filter((name: string) => name.startsWith(prefix)).sort()).toEqual([...XHS_READ_TOOLS].sort());
  });

  it('sends best-effort MCP cancellation when a tool request times out', async () => {
    const writes: string[] = [];
    const client = new McpClient({ name: 'fake', command: 'unused' });
    (client as unknown as { proc: unknown }).proc = { stdin: { write: (text: string) => writes.push(text) } };
    await expect(client.callTool('slow', {}, 5)).rejects.toThrow('timed out');
    const messages = writes.map(text => JSON.parse(text));
    expect(messages[1]).toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: messages[0].id, reason: 'Tool deadline exceeded' },
    });
  });
});
