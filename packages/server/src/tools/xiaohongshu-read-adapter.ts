import { randomUUID } from 'node:crypto';
import type { McpCallResult } from './mcp-client.js';
import type { XiaohongshuPhase, XiaohongshuProgress } from './xiaohongshu-session.js';

export const XHS_READ_TOOLS = new Set([
  'mcp__xiaohongshu__check_login_status',
  'mcp__xiaohongshu__search_feeds',
  'mcp__xiaohongshu__get_feed_detail',
]);

type ReadCall = (args: Record<string, unknown>, timeoutMs: number) => Promise<McpCallResult>;
type Reference = { scope: string; feedId: string; token: string; expiresAt: number };
const TTL_MS = 15 * 60_000;
const MAX_REFERENCES = 500;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function textOf(result: McpCallResult): string {
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    return result.content.flatMap(block => {
      const value = record(block);
      return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
    }).join('\n');
  }
  return JSON.stringify(result.content);
}

/** Only server memory sees access tokens. References are task+agent scoped and
 * expire on restart/TTL; neither prompts, artifacts nor persistent logs need them. */
export class XiaohongshuReadAdapter {
  private references = new Map<string, Reference>();
  private busy = false;

  constructor(private readonly now = Date.now) {}

  private prune() {
    for (const [id, value] of this.references) {
      if (value.expiresAt <= this.now()) this.references.delete(id);
    }
  }

  private remember(scope: string, feedId: string, token: string): string {
    this.prune();
    while (this.references.size >= MAX_REFERENCES) {
      this.references.delete(this.references.keys().next().value!);
    }
    const id = `xhsref_${randomUUID()}`;
    this.references.set(id, { scope, feedId, token, expiresAt: this.now() + TTL_MS });
    return id;
  }

  private safe(value: unknown, secrets: string[], depth = 0): unknown {
    if (depth > 12) return '[nested content omitted]';
    if (typeof value === 'string') {
      let safe = value.replace(/https?:\/\/[^\s"<>]*(?:xsec|token|signature)[^\s"<>]*/gi, '[signed URL omitted]');
      for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
      return safe.length > 6_000 ? `${safe.slice(0, 6_000)}\n[excerpt truncated]` : safe;
    }
    if (Array.isArray(value)) return value.slice(0, 12).map(item => this.safe(item, secrets, depth + 1));
    const object = record(value);
    if (!object) return value;
    return Object.fromEntries(Object.entries(object)
      .filter(([key]) => !/token|cookie|authorization|secret|signature|cursor|url|image|video|cover|avatar/i.test(key))
      .map(([key, item]) => [key, this.safe(item, secrets, depth + 1)]));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    scope: string | undefined,
    call: ReadCall,
    timeoutMs?: number,
    onProgress?: XiaohongshuProgress,
  ) {
    const startedAt = this.now();
    const report = (phase: XiaohongshuPhase, message: string) =>
      onProgress?.({ phase, message, elapsedMs: Math.max(0, this.now() - startedAt) });
    const fail = (output: string) => ({ status: 'failed' as const, output });
    if (!scope) return fail('Xiaohongshu reads require a task-scoped Agent context.');
    if (this.busy) return fail('Xiaohongshu read is busy. Wait for the current call; do not retry in a loop.');
    this.prune();
    let input: Record<string, unknown>;
    let detail: Reference | undefined;
    if (name.endsWith('__get_feed_detail')) {
      detail = this.references.get(String(args.note_ref || ''));
      if (!detail || detail.scope !== scope) {
        return fail('Note reference is missing, expired, or belongs to another task. Search again to obtain a fresh note_ref.');
      }
      input = { feed_id: detail.feedId, xsec_token: detail.token, load_all_comments: false };
    } else if (name.endsWith('__search_feeds')) {
      if (typeof args.keyword !== 'string' || !args.keyword.trim() || args.keyword.length > 200) {
        return fail('Search requires a keyword between 1 and 200 characters.');
      }
      input = { keyword: args.keyword.trim() };
      // Ignore unknown model input fields; never forward credentials supplied by a model.
    } else if (name.endsWith('__check_login_status')) {
      input = {};
    } else {
      return fail('Not an allowed Xiaohongshu read tool.');
    }
    this.busy = true;
    try {
      const operation = name.endsWith('__search_feeds') ? 'search' : name.endsWith('__get_feed_detail') ? 'detail' : 'status';
      const limit = operation === 'search' ? 55_000 : operation === 'detail' ? 45_000 : 15_000;
      report(operation === 'search' ? 'requesting_search' : operation === 'detail' ? 'requesting_detail' : 'checking_login',
        operation === 'search' ? '正在等待小红书搜索结果' : operation === 'detail' ? '正在读取小红书笔记详情' : '正在读取登录状态');
      const result = await call(input, Math.max(1, Math.min(timeoutMs ?? limit, limit)));
      const text = textOf(result);
      report('parsing_response', '小红书已返回数据，正在解析');
      if (text.length > 2_000_000) return fail('Xiaohongshu response exceeds the safe parsing limit. Narrow the query.');
      if (!/^\s*[\[{]/.test(text) && /(?:验证码|安全验证|访问频繁|操作频繁|账号异常|环境异常|风控|captcha|verify|risk control)/i.test(text)) {
        return fail('[XHS_CHALLENGE] 小红书要求安全验证或触发访问限制。请在登录浏览器中完成验证后再试；不要循环搜索。');
      }
      if (!/^\s*[\[{]/.test(text) && /未登录|not\s+logged\s+in|login\s+required|请.*登录/i.test(text)) {
        return fail('Xiaohongshu is not logged in. Ask the user to complete the local Xiaohongshu MCP login; no site search was verified. Do not retry or substitute invented results.');
      }
      if (result.isError) return fail('Xiaohongshu returned an error. No verified result is available; stop this lookup.');
      if (name.endsWith('__check_login_status')) {
        return /已登录|logged\s+in/i.test(text)
          ? { status: 'done' as const, output: 'Xiaohongshu login verified. Read-only search is available.' }
          : fail('Xiaohongshu login status was not recognized. Ask the user to verify login.');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        return fail('Xiaohongshu returned an unexpected non-JSON result. No verified evidence was extracted.');
      }
      const secrets = detail ? [detail.token] : [];
      const notes: Record<string, unknown>[] = [];
      const visit = (value: unknown, depth = 0) => {
        if (depth > 16) return;
        if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
        const object = record(value);
        if (!object) return;
        for (const [key, item] of Object.entries(object)) {
          if (/token|secret|signature/i.test(key) && typeof item === 'string') secrets.push(item);
        }
        const token = object.xsecToken ?? object.xsec_token;
        const feedId = object.id ?? object.feed_id ?? object.feedId;
        if (typeof feedId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(feedId)
          && (object.noteCard || object.note_card || object.displayTitle || object.title)) {
          const card = record(object.noteCard ?? object.note_card) || object;
          notes.push({
            feed_id: feedId,
            title: card.displayTitle ?? card.title ?? '',
            author: record(card.user)?.nickname ?? '',
            interactions: card.interactInfo ?? card.interact_info,
            source_url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(feedId)}`,
            ...(notes.length < 12 && typeof token === 'string' && token ? { note_ref: this.remember(scope, feedId, token) } : {}),
          });
        }
        Object.values(object).forEach(item => visit(item, depth + 1));
      };
      visit(parsed);
      if (name.endsWith('__search_feeds')) {
        // Treat unknown response formats as errors, not false zero-result successes.
        const outer = record(parsed);
        const data = record(outer?.data);
        if (!Array.isArray(parsed) && !Array.isArray(outer?.feeds) && !Array.isArray(data?.feeds) && notes.length === 0) {
          return fail('Unrecognized Xiaohongshu search response; no verified results could be extracted.');
        }
        return {
          status: 'done' as const,
          output: JSON.stringify({
            source: 'xiaohongshu MCP', retrieved_at: new Date(this.now()).toISOString(),
            notes: notes.slice(0, 12).map(note => ({
              ...this.safe(note, secrets) as object,
              source_url: note.source_url,
            })),
            omitted: Math.max(0, notes.length - 12),
            notice: 'User-generated claims, not verified prices. Use note_ref for details; references expire after 15 minutes or server restart.',
          }),
        };
      }
      return {
        status: 'done' as const,
        output: JSON.stringify({
          source: 'xiaohongshu MCP', source_url: `https://www.xiaohongshu.com/explore/${encodeURIComponent(detail!.feedId)}`,
          retrieved_at: new Date(this.now()).toISOString(), evidence: this.safe(parsed, secrets),
          notice: 'Bounded excerpt: first 12 items per list, 6000 characters per text field; media and credentials omitted. User-generated claims are not verified facts.',
        }),
      };
    } catch {
      // Do not echo transport errors: some servers include request arguments.
      const operation = name.endsWith('__search_feeds') ? 'search' : name.endsWith('__get_feed_detail') ? 'detail' : 'status';
      const limit = operation === 'search' ? 55 : operation === 'detail' ? 45 : 15;
      return fail(`[XHS_READ_TIMEOUT] Xiaohongshu ${operation} did not return a parseable response within ${limit} seconds. Preserve earlier evidence, stop repeated attempts, and report the missing source.`);
    } finally {
      this.busy = false;
    }
  }
}

export const xiaohongshuReadAdapter = new XiaohongshuReadAdapter();

export function xiaohongshuReadSchema(name: string): Record<string, unknown> {
  if (name.endsWith('__get_feed_detail')) return {
    type: 'object', properties: { note_ref: { type: 'string', description: 'Task-scoped note_ref returned by search_feeds. Never supply an access token.' } },
    required: ['note_ref'], additionalProperties: false,
  };
  if (name.endsWith('__search_feeds')) return {
    type: 'object', properties: { keyword: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['keyword'], additionalProperties: false,
  };
  return { type: 'object', properties: {}, additionalProperties: false };
}
