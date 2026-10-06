import { getMcpManager } from './mcp-manager.js';
import type { McpCallResult } from './mcp-client.js';

export type XiaohongshuStatus = { authenticated: boolean; state: 'logged_in' | 'login_required' | 'unavailable'; checkedAt: string };
export type XiaohongshuPhase =
  | 'queued'
  | 'checking_login'
  | 'login_cached'
  | 'requesting_search'
  | 'requesting_detail'
  | 'parsing_response'
  | 'completed'
  | 'login_required'
  | 'challenge'
  | 'queue_timeout'
  | 'read_timeout'
  | 'failed';
export type XiaohongshuPhaseEvent = { phase: XiaohongshuPhase; message: string; elapsedMs: number };
export type XiaohongshuDiagnostics = {
  source: 'xiaohongshu';
  operation: 'status' | 'search' | 'detail';
  durationMs: number;
  phases: XiaohongshuPhaseEvent[];
};
export type XiaohongshuToolResult = {
  status: 'done' | 'failed';
  output: string;
  diagnostics: XiaohongshuDiagnostics;
};
export type XiaohongshuProgress = (event: XiaohongshuPhaseEvent) => void;
type Call = (name: string, args: Record<string, unknown>, timeoutMs: number) => Promise<McpCallResult>;
const PREFIX = 'mcp__xiaohongshu__';
const LOGIN_REQUIRED = '[XHS_LOGIN_REQUIRED] 小红书 MCP 未登录。请前往 Home 的“工具与服务”区域登录小红书，确认登录后再重试。未取得站内资料，不要编造结果。';

export class XiaohongshuSession {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private lastStatus?: { at: number; status: XiaohongshuStatus };

  constructor(private readonly call: Call, private readonly now = Date.now) {}

  /** One browser operation at a time; expired queued work never starts later. */
  private async exclusive<T>(operation: (remaining: () => number) => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.queued >= 8) throw new Error('[XHS_QUEUE_FULL]');
    const deadline = this.now() + timeoutMs;
    this.queued++;
    let expired = false;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = () => Math.max(1, deadline - this.now());
    const work = this.tail.then(() => {
      if (expired || this.now() >= deadline) throw new Error('[XHS_QUEUE_TIMEOUT]');
      started = true;
      return operation(remaining);
    });
    this.tail = work.catch(() => undefined).finally(() => { this.queued--; });
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(new Error(started ? '[XHS_READ_TIMEOUT]' : '[XHS_QUEUE_TIMEOUT]')); }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async check(remaining: () => number, force = false, report?: (phase: XiaohongshuPhase, message: string) => void): Promise<XiaohongshuStatus> {
    if (!force && this.lastStatus && this.now() - this.lastStatus.at < (this.lastStatus.status.authenticated ? 120_000 : 5_000)) {
      report?.('login_cached', '复用最近验证过的登录状态');
      return this.lastStatus.status;
    }
    report?.('checking_login', '正在检查小红书登录状态');
    let state: XiaohongshuStatus['state'] = 'unavailable';
    try {
      const result = await this.call(`${PREFIX}check_login_status`, {}, Math.min(15_000, remaining()));
      const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      if (!result.isError && /未登录|not\s+logged\s+in|login\s+required/i.test(text)) state = 'login_required';
      else if (!result.isError && /已登录|logged\s+in/i.test(text)) state = 'logged_in';
    } catch { /* Connection failure is different from not being logged in. */ }
    const status = { authenticated: state === 'logged_in', state, checkedAt: new Date(this.now()).toISOString() };
    this.lastStatus = { at: this.now(), status };
    return status;
  }

  status(): Promise<XiaohongshuStatus> {
    return this.exclusive(remaining => this.check(remaining, true), 20_000);
  }

  async agentRead(
    name: string,
    read: (timeoutMs: number, report: (phase: XiaohongshuPhase, message: string) => void) => Promise<{ status: 'done' | 'failed'; output: string }>,
    timeoutMs?: number,
    onProgress?: XiaohongshuProgress,
  ): Promise<XiaohongshuToolResult> {
    const startedAt = this.now();
    const phases: XiaohongshuPhaseEvent[] = [];
    const operation = name.endsWith('__search_feeds') ? 'search' : name.endsWith('__get_feed_detail') ? 'detail' : 'status';
    const report = (phase: XiaohongshuPhase, message: string) => {
      const event = { phase, message, elapsedMs: Math.max(0, this.now() - startedAt) };
      phases.push(event);
      onProgress?.(event);
    };
    const finish = (status: 'done' | 'failed', output: string): XiaohongshuToolResult => ({
      status,
      output,
      diagnostics: {
        source: 'xiaohongshu',
        operation,
        durationMs: Math.max(0, this.now() - startedAt),
        phases,
      },
    });
    // Search/detail budgets include queue handoff, an optional login probe,
    // upstream browser work, parsing, and a small scheduling margin.
    const operationBudget = operation === 'search' ? 75_000 : operation === 'detail' ? 65_000 : 20_000;
    report('queued', '已进入小红书浏览器操作队列');
    try {
      const result = await this.exclusive(async remaining => {
        const status = await this.check(remaining, false, report);
        if (!status.authenticated) {
          report(status.state === 'login_required' ? 'login_required' : 'failed',
            status.state === 'login_required' ? '小红书账号需要登录' : '登录检查不可用');
          return {
            status: 'failed' as const,
            output: status.state === 'login_required' ? LOGIN_REQUIRED : '[XHS_UNAVAILABLE] 小红书 MCP 登录检查不可用，请检查服务后再重试；未执行搜索。',
          };
        }
        if (name === `${PREFIX}check_login_status`) return { status: 'done' as const, output: '小红书 MCP 已登录，可以执行只读搜索。' };
        // The authentication probe uses the same total deadline as the read.
        if (remaining() <= 1) return { status: 'failed' as const, output: '[XHS_TIMEOUT] 登录检查后预算已耗尽，未执行搜索。' };
        const result = await read(remaining(), report);
        // A search timeout is not evidence that the account logged out.
        if (result.status === 'failed' && /XHS_LOGIN_REQUIRED|未登录|not\s+logged\s+in/i.test(result.output)) this.lastStatus = undefined;
        return result;
      }, Math.max(1, Math.min(timeoutMs ?? operationBudget, operationBudget)));
      const challenge = /\[XHS_CHALLENGE\]/.test(result.output);
      const readTimeout = /\[XHS_READ_TIMEOUT\]/.test(result.output);
      report(result.status === 'done' ? 'completed' : challenge ? 'challenge' : readTimeout ? 'read_timeout' : 'failed',
        result.status === 'done' ? '小红书操作完成'
          : challenge ? '小红书要求安全验证'
            : readTimeout ? '小红书上游页面或接口未在预算内返回'
              : '小红书操作未完成');
      return finish(result.status, result.output);
    } catch (err) {
      const queued = err instanceof Error && /\[XHS_QUEUE_(?:FULL|TIMEOUT)\]/.test(err.message);
      report(queued ? 'queue_timeout' : 'read_timeout',
        queued ? '等待小红书浏览器操作超时' : '小红书上游页面或接口未在预算内返回');
      return finish('failed', queued
        ? '[XHS_QUEUE_TIMEOUT] 小红书服务繁忙，排队预算已耗尽，未执行本次查询；这不代表登录失效。请整理已有资料，不要循环调用。'
        : '[XHS_READ_TIMEOUT] 小红书查询执行超时，已停止等待；上游没有在时限内返回可解析结果，这不代表登录失效。已有资料会保留，请勿循环调用。');
    }
  }

  async qrCode(): Promise<{ image?: string; authenticated: boolean; expiresAt?: string }> {
    return this.exclusive(async remaining => {
      const status = await this.check(remaining, true);
      if (status.authenticated) return { authenticated: true };
      if (status.state === 'unavailable') throw new Error('小红书 MCP 无法连接，请检查服务。');
      const result = await this.call(`${PREFIX}get_login_qrcode`, {}, Math.min(30_000, remaining()));
      this.lastStatus = undefined;
      if (result.isError || !Array.isArray(result.content)) throw new Error('无法获取小红书登录二维码，请重试。');
      const image = result.content.find((block: { type?: string; mimeType?: string; data?: string }) =>
        block.type === 'image' && ['image/png', 'image/jpeg'].includes(block.mimeType || '') && typeof block.data === 'string');
      if (!image || image.data.length > 2_000_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(image.data)) {
        throw new Error('小红书未返回有效登录二维码，请刷新状态后重试。');
      }
      return {
        authenticated: false, image: `data:${image.mimeType};base64,${image.data}`,
        // UI refresh window, not a claim about the upstream QR's exact lifetime.
        expiresAt: new Date(this.now() + 120_000).toISOString(),
      };
    }, 45_000);
  }
}

export const xiaohongshuSession = new XiaohongshuSession((name, args, timeout) => getMcpManager().callTool(name, args, timeout));
