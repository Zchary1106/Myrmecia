/**
 * Sandboxed tool executor for agent tool calls.
 * Implements registry-backed tools plus local file/shell helpers with workspace confinement.
 */
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, normalize, dirname, relative, isAbsolute, join } from 'path';
import { guardrails } from '../agents/safety-guardrails.js';
import { getRuntimeLimits } from '../agents/runtime-limits.js';
import { formatToolGuardianDecision, formatToolGuardianWarnings, redactSecrets, reviewToolCall } from './tool-guardian.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ToolResult {
  output: string;
  status: 'done' | 'failed';
}

export interface ToolSandboxOptions {
  allowedTools?: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
}

export const SANDBOX_TOOL_NAMES = [
  'file_read',
  'file_write',
  'shell_exec',
  'grep',
  'search',
  'web.fetch',
  'web.search',
  'crawler.extract_links',
  'content.wechat_layout',
  'content.hashtag_plan',
  'image.generate_svg',
] as const;

const SANDBOX_TOOL_SET = new Set<string>(SANDBOX_TOOL_NAMES);

export function isSandboxTool(toolName: string): boolean {
  return SANDBOX_TOOL_SET.has(toolName);
}

export function buildSandboxToolDefinition(toolName: string, modelToolName = toolName) {
  const descriptionByTool: Record<string, string> = {
    file_read: 'Read a UTF-8 file from the task workspace.',
    file_write: 'Write a UTF-8 file inside the task workspace.',
    shell_exec: 'Run a shell command in the task workspace with guardrail checks and a timeout.',
    grep: 'Search workspace text files for a pattern.',
    search: 'Search workspace text files for a pattern.',
    'web.fetch': 'Fetch an absolute http/https URL and return compact text.',
    'web.search': 'Search the public web and return compact result titles and URLs.',
    'crawler.extract_links': 'Fetch a page and extract visible links.',
    'content.wechat_layout': 'Convert a markdown draft into WeChat layout recommendations and HTML blocks.',
    'content.hashtag_plan': 'Generate platform hashtag and keyword suggestions.',
    'image.generate_svg': 'Generate a simple SVG cover image in the task workspace.',
  };
  return {
    type: 'function' as const,
    function: {
      name: modelToolName,
      description: descriptionByTool[toolName] || `Tool: ${toolName}`,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: true },
    },
  };
}

/** Validate that a resolved path is within the workspace boundary */
function assertSafePath(workdir: string, inputPath: string): string {
  const workspace = normalize(resolve(workdir));
  const resolved = resolve(workspace, inputPath);
  const normalized = normalize(resolved);
  const rel = relative(workspace, normalized);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path traversal blocked: "${inputPath}" resolves outside workspace`);
  }
  return resolved;
}

/** Block dangerous shell command patterns */
const BLOCKED_COMMANDS = /\b(rm\s+-rf\s+\/|sudo|chmod\s+777|curl.*\|\s*(?:sh|bash)|wget.*\|\s*(?:sh|bash)|eval|exec\s)|\$\{[^}]+@P\}|\$\{![^}]+\}|\$\(/i;

function uniqueOperations(operations: string[]): string[] {
  return Array.from(new Set(operations));
}

export function classifyShellOperations(command: string): string[] {
  const operations: string[] = [];
  if (/\brm\b|\bunlink\b|\bshred\b|\bgit\s+clean\s+-/i.test(command)) {
    operations.push('delete_files');
  }
  if (/\bgit\s+(?:reset\s+--hard|rebase|push\s+--force|filter-branch|update-ref)\b/i.test(command)) {
    operations.push('force_push');
  }
  if (/\b(?:kubectl|helm)\b|\bterraform\s+apply\b|\bserverless\s+deploy\b|\baws\s+cloudformation\s+deploy\b|\bgcloud\s+app\s+deploy\b|\bvercel\b.*\s--prod\b|\bnetlify\s+deploy\b.*\s--prod\b/i.test(command)) {
    operations.push('deploy');
  }
  if (/\b(?:curl|wget|ssh|scp|rsync|nc|ncat|telnet)\b/i.test(command)) {
    operations.push('network_access');
  }
  return uniqueOperations(operations);
}

export function assertShellCommandAllowed(command: string): void {
  if (!command.trim()) {
    throw new Error('shell_exec requires a non-empty command');
  }
  const guardianDecision = reviewToolCall('shell_exec', { command });
  if (!guardianDecision.allowed) {
    throw new Error(formatToolGuardianDecision(guardianDecision));
  }
  if (BLOCKED_COMMANDS.test(command)) {
    throw new Error('Dangerous shell command pattern detected');
  }

  for (const operation of classifyShellOperations(command)) {
    const decision = guardrails.checkOperation(operation);
    if (!decision.allowed) {
      throw new Error(decision.reason || `Operation "${operation}" is blocked by guardrails`);
    }
  }
}

function assertNetworkAllowed(): void {
  const decision = guardrails.checkOperation('network_access');
  if (!decision.allowed) {
    throw new Error(decision.reason || 'Network access is blocked by guardrails');
  }
}

function capOutput(output: string, maxOutputChars: number): string {
  const capped = output.length > maxOutputChars ? output.slice(0, maxOutputChars) : output;
  return redactSecrets(capped);
}

function compactText(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value: string): URL {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Only absolute http/https URLs are allowed');
  }
  return url;
}

async function fetchText(urlValue: string, timeoutMs: number, maxOutputChars: number): Promise<string> {
  assertNetworkAllowed();
  const url = safeUrl(urlValue);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AgentFactoryBot/0.1 (+https://github.com/agent-factory)',
        Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString(contentType.includes('charset=') ? undefined : 'utf-8');
    return compactText(text, maxOutputChars);
  } finally {
    clearTimeout(timeout);
  }
}

function parseLinks(page: string, baseUrl: string, maxLinks: number): Array<{ title: string; url: string }> {
  const links: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of page.matchAll(anchorPattern)) {
    const rawHref = match[1];
    const title = compactText(match[2].replace(/<[^>]+>/g, ' '), 160);
    if (!title) continue;
    let href = rawHref;
    if (href.includes('uddg=')) {
      const parsed = new URL(href, baseUrl);
      href = parsed.searchParams.get('uddg') || href;
    }
    const absolute = new URL(href, baseUrl).toString();
    if (!absolute.startsWith('http') || seen.has(absolute)) continue;
    seen.add(absolute);
    links.push({ title, url: absolute });
    if (links.length >= maxLinks) break;
  }
  return links;
}

function jsonToolOutput(value: unknown, maxOutputChars: number): string {
  return capOutput(JSON.stringify(value, null, 2), maxOutputChars);
}

/**
 * Execute a tool call within a sandboxed workspace context.
 * All file operations are confined to `workdir`.
 */
export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  workdir: string,
  options: ToolSandboxOptions = {},
): Promise<ToolResult> {
  const limits = getRuntimeLimits();
  const timeoutMs = options.timeoutMs ?? limits.maxToolCallTimeoutMs;
  const maxOutputChars = options.maxOutputChars ?? 8_000;

  if (options.allowedTools && !options.allowedTools.includes(toolName)) {
    return { output: `Tool "${toolName}" is not allowed for this execution.`, status: 'failed' };
  }

  const guardianDecision = reviewToolCall(toolName, toolInput);
  if (!guardianDecision.allowed) {
    return { output: capOutput(formatToolGuardianDecision(guardianDecision), Math.min(maxOutputChars, 4_000)), status: 'failed' };
  }
  const guardianWarnings = formatToolGuardianWarnings(guardianDecision);
  const capWithGuardianWarnings = (output: string): string => {
    const combined = guardianWarnings ? `${guardianWarnings}\n\n${output}` : output;
    return capOutput(combined, maxOutputChars);
  };

  if (toolName === 'shell_exec') {
    try {
      const cmd = String(toolInput.command || toolInput.cmd || '');
      assertShellCommandAllowed(cmd);
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: workdir,
        timeout: timeoutMs,
        maxBuffer: Math.max(maxOutputChars * 4, 16_384),
        shell: '/bin/bash',
        encoding: 'utf-8',
      });
      return { output: capWithGuardianWarnings(stdout + (stderr ? `\nSTDERR: ${stderr}` : '')), status: 'done' };
    } catch (err: any) {
      const details = err.stdout || err.stderr
        ? `Exit ${err.code}: ${(err.stdout || '') + (err.stderr || '')}`
        : err.message || 'shell_exec failed';
      return { output: capOutput(details, Math.min(maxOutputChars, 4_000)), status: 'failed' };
    }
  }

  if (toolName === 'file_write') {
    try {
      const filePath = assertSafePath(workdir, String(toolInput.path || toolInput.file_path || ''));
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, String(toolInput.content || ''), 'utf-8');
      return { output: capOutput(`Written: ${filePath}`, maxOutputChars), status: 'done' };
    } catch (err: any) {
      return { output: `Write failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'file_read') {
    try {
      const filePath = assertSafePath(workdir, String(toolInput.path || toolInput.file_path || ''));
      const content = readFileSync(filePath, 'utf-8');
      return { output: capOutput(content, maxOutputChars), status: 'done' };
    } catch (err: any) {
      return { output: `Read failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'grep' || toolName === 'search') {
    try {
      const pattern = String(toolInput.pattern || toolInput.query || '');
      if (!pattern.trim()) throw new Error('grep requires a non-empty pattern');
      const { stdout } = await execFileAsync(
        'grep',
        ['-R', '-n', '-I', '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx', pattern, '.'],
        { cwd: workdir, encoding: 'utf-8', timeout: Math.min(timeoutMs, 10_000), maxBuffer: Math.max(maxOutputChars * 4, 16_384) },
      );
      return { output: capOutput(stdout || 'No matches', Math.min(maxOutputChars, 4_000)), status: 'done' };
    } catch (err: any) {
      return { output: capOutput(err.stdout || 'No matches', Math.min(maxOutputChars, 2_000)), status: err.code === 1 ? 'done' : 'failed' };
    }
  }

  if (toolName === 'web.fetch') {
    try {
      const output = await fetchText(String(toolInput.url || ''), Math.min(timeoutMs, 15_000), maxOutputChars);
      return { output, status: 'done' };
    } catch (err: any) {
      return { output: `Fetch failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'web.search') {
    try {
      const query = String(toolInput.query || '');
      if (!query.trim()) throw new Error('web.search requires a query');
      const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const page = await fetchText(searchUrl, Math.min(timeoutMs, 15_000), 80_000);
      const links = parseLinks(page, searchUrl, 8);
      return { output: jsonToolOutput(links, maxOutputChars), status: 'done' };
    } catch (err: any) {
      return { output: `Search failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'crawler.extract_links') {
    try {
      const url = String(toolInput.url || '');
      const page = await fetchText(url, Math.min(timeoutMs, 15_000), 120_000);
      const links = parseLinks(page, safeUrl(url).toString(), 50);
      return { output: jsonToolOutput(links, maxOutputChars), status: 'done' };
    } catch (err: any) {
      return { output: `Extract links failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'content.hashtag_plan') {
    const topic = compactText(String(toolInput.topic || ''), 120);
    const keywords = [topic, `${topic}教程`, `${topic}经验`, `${topic}避坑`, `${topic}工具`].filter(Boolean);
    return {
      output: jsonToolOutput({
        topic,
        wechat_keywords: keywords.slice(0, 4),
        xiaohongshu_tags: keywords.map(keyword => `#${keyword}`),
        search_intent: ['入门了解', '方案对比', '实操教程', '避坑清单'],
      }, maxOutputChars),
      status: 'done',
    };
  }

  if (toolName === 'content.wechat_layout') {
    const markdown = String(toolInput.markdown || '');
    const paragraphs = markdown.split('\n').map(line => line.trim()).filter(Boolean);
    const html = paragraphs.map(paragraph => {
      if (paragraph.startsWith('#')) {
        const text = escapeHtml(paragraph.replace(/^#+\s*/, ''));
        return `<h2>${text}</h2>`;
      }
      return `<p>${escapeHtml(paragraph)}</p>`;
    }).join('\n');
    return {
      output: jsonToolOutput({
        layout: '公众号图文排版',
        recommendations: ['首屏使用标题 + 摘要 + 封面图', '每 3-5 段设置一个小标题', '末尾加入总结和互动问题'],
        html,
      }, maxOutputChars),
      status: 'done',
    };
  }

  if (toolName === 'image.generate_svg') {
    try {
      const title = compactText(String(toolInput.title || toolInput.spec || 'Untitled'), 80);
      const subtitle = compactText(String(toolInput.subtitle || 'Agent Factory'), 80);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500" viewBox="0 0 900 500"><rect width="900" height="500" fill="#2563eb"/><text x="72" y="150" fill="#f8fafc" font-size="28" font-family="Arial">${escapeHtml(subtitle)}</text><text x="72" y="260" fill="#f8fafc" font-size="56" font-family="Arial" font-weight="700">${escapeHtml(title)}</text></svg>`;
      const outDir = assertSafePath(workdir, 'generated-assets');
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, 'cover.svg');
      writeFileSync(outPath, svg, 'utf-8');
      return { output: jsonToolOutput({ path: outPath, format: 'svg', preview: svg.slice(0, 1000) }, maxOutputChars), status: 'done' };
    } catch (err: any) {
      return { output: `SVG generation failed: ${err.message}`, status: 'failed' };
    }
  }

  return { output: `Tool "${toolName}" is not available in skill executor sandbox.`, status: 'failed' };
}
