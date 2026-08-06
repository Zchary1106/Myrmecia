/**
 * Sandboxed tool executor for agent tool calls.
 * Implements registry-backed tools plus local file/shell helpers with workspace confinement.
 */
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, normalize, dirname, relative, isAbsolute, join, extname } from 'path';
import sharp from 'sharp';
import { parse as parseYaml } from 'yaml';
import { guardrails } from '../agents/safety-guardrails.js';
import { getRuntimeLimits } from '../agents/runtime-limits.js';
import { assertLocalShellAllowed, assertNetworkToolAllowed } from '../agents/sandbox-profile.js';
import { formatToolGuardianDecision, formatToolGuardianWarnings, redactSecrets, reviewToolCall } from './tool-guardian.js';
import {
  renderCards,
  renderWeChatCover,
  CARD_WIDTH,
  CARD_HEIGHT,
  WECHAT_COVER_WIDTH,
  WECHAT_COVER_HEIGHT,
  type CardRenderSpec,
  type WeChatCoverSpec,
} from '../tools/image-cards.js';
import { generateComfyImages, type ComfyGenerateSpec } from '../tools/comfyui-images.js';
import {
  createSocialMonitorJobs,
  findSocialScheduleConflicts,
  getActiveSocialComplianceRulebook,
} from '../db/models/social-workflow.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ToolResult {
  output: string;
  status: 'done' | 'failed';
}

export interface ToolSandboxOptions {
  allowedTools?: string[];
  workspaceId?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  /**
   * Reports incremental progress from long-running tools so the operator sees
   * movement instead of a silent multi-minute gap between start and finish.
   */
  onProgress?: (update: { message: string; ratio: number }) => void;
}

export const SANDBOX_TOOL_NAMES = [
  'file_read',
  'file_write',
  'file_list',
  'apply_patch',
  'shell_exec',
  'grep',
  'search',
  'web.fetch',
  'web.search',
  'web.extract',
  'crawler.extract_links',
  'content.wechat_layout',
  'content.hashtag_plan',
  'content.compliance_check',
  'media.inspect',
  'social.schedule_check',
  'social.monitor_plan',
  'image.generate_svg',
  'image.generate_cards',
  'image.generate_comfyui',
  'image.generate_wechat_cover',
] as const;

const SANDBOX_TOOL_SET = new Set<string>(SANDBOX_TOOL_NAMES);

export function isSandboxTool(toolName: string): boolean {
  return SANDBOX_TOOL_SET.has(toolName);
}

export function buildSandboxToolDefinition(toolName: string, modelToolName = toolName) {
  const descriptionByTool: Record<string, string> = {
    file_read: 'Read a UTF-8 file from the task workspace.',
    file_write: 'Create or overwrite a UTF-8 file inside the task workspace.',
    file_list: 'List files/directories in the task workspace (recursive, capped).',
    apply_patch: 'Make a surgical edit: replace one exact occurrence of old_str with new_str in a workspace file (token-efficient vs. rewriting the whole file).',
    shell_exec: 'Run a shell command in the task workspace with guardrail checks and a timeout.',
    grep: 'Search workspace text files for a pattern.',
    search: 'Search workspace text files for a pattern.',
    'web.fetch': 'Fetch an absolute http/https URL and return compact text.',
    'web.search': 'Search the public web and return compact result titles and URLs.',
    'web.extract': 'Fetch a page and return structured text with source citations.',
    'crawler.extract_links': 'Fetch a page and extract visible links.',
    'content.wechat_layout': 'Convert a markdown draft into WeChat layout recommendations and HTML blocks.',
    'content.hashtag_plan': 'Generate platform hashtag and keyword suggestions.',
    'content.compliance_check': 'Deterministically apply the configured social compliance rulebook to platform drafts and return structured findings.',
    'media.inspect': 'Inspect a local image or video for size, dimensions, format, codec/duration when available, and metadata risk.',
    'social.schedule_check': 'Check durable social publishing schedules for account/time conflicts.',
    'social.monitor_plan': 'Persist 48/72/168-hour post-publication monitoring jobs.',
    'image.generate_svg': 'Generate a simple SVG cover image in the task workspace.',
    'image.generate_cards': 'Render Xiaohongshu-style 1080x1440 PNG image cards (cover / numbered point / list / ending) into the task workspace and return their absolute file paths, ready to pass straight to a note-publishing tool.',
    'image.generate_comfyui': 'Generate AI illustrations (covers, scene art, backgrounds) with the local ComfyUI server and return absolute PNG paths. Roughly 1 minute per image, so keep to 1-3 prompts; use image.generate_cards for anything containing text, since diffusion models cannot render readable Chinese.',
    'image.generate_wechat_cover': 'Render a 900x383 PNG cover for a WeChat Official Account article and return its absolute path.',
  };
  const schemaByTool: Record<string, { properties: Record<string, unknown>; required?: string[] }> = {
    file_read: { properties: { path: { type: 'string', description: 'Workspace-relative file path' } }, required: ['path'] },
    file_write: { properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    file_list: { properties: { path: { type: 'string', description: 'Optional subdirectory (default workspace root)' } } },
    apply_patch: {
      properties: {
        path: { type: 'string' },
        old_str: { type: 'string', description: 'Exact text to replace (must match a single occurrence)' },
        new_str: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_str', 'new_str'],
    },
    shell_exec: { properties: { command: { type: 'string' } }, required: ['command'] },
    grep: { properties: { pattern: { type: 'string' }, glob: { type: 'string', description: 'Optional file glob, e.g. *.ts' } }, required: ['pattern'] },
    search: { properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    'content.compliance_check': {
      properties: {
        content_id: { type: 'string' },
        workspace_id: { type: 'string' },
        documents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              platform: { type: 'string', enum: ['douyin', 'xiaohongshu', 'wechat'] },
              title: { type: 'string' },
              body: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['platform'],
          },
        },
      },
      required: ['content_id', 'workspace_id', 'documents'],
    },
    'media.inspect': {
      properties: {
        path: { type: 'string', description: 'File path inside the task workspace' },
      },
      required: ['path'],
    },
    'social.schedule_check': {
      properties: {
        workspace_id: { type: 'string' },
        platform: { type: 'string', enum: ['douyin', 'xiaohongshu', 'wechat'] },
        account_id: { type: 'string' },
        schedule_at: { type: 'string' },
        window_minutes: { type: 'integer' },
        exclude_content_id: { type: 'string' },
      },
      required: ['workspace_id', 'platform', 'account_id', 'schedule_at'],
    },
    'social.monitor_plan': {
      properties: {
        workspace_id: { type: 'string' },
        content_id: { type: 'string' },
        platform: { type: 'string', enum: ['douyin', 'xiaohongshu', 'wechat'] },
        publish_id: { type: 'string' },
        published_at: { type: 'string' },
      },
      required: ['workspace_id', 'content_id', 'platform', 'publish_id', 'published_at'],
    },
    'web.fetch': { properties: { url: { type: 'string', description: 'Absolute http/https URL' } }, required: ['url'] },
    'web.search': { properties: { query: { type: 'string' } }, required: ['query'] },
    'web.extract': {
      properties: {
        url: { type: 'string', description: 'Absolute http/https URL' },
        maxChars: { type: 'integer', description: 'Maximum extracted text length, capped by runtime limits' },
      },
      required: ['url'],
    },
    'image.generate_cards': {
      properties: {
        cards: {
          type: 'array',
          description: 'Ordered image cards (max 12). Card 1 is the cover. Wrap a phrase in **double asterisks** to highlight it in the accent colour.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['cover', 'point', 'list', 'end'], description: 'cover=封面页, point=编号要点页, list=清单页, end=结尾互动页' },
              tag: { type: 'string', description: 'cover: small pill label, e.g. 远程办公' },
              title: { type: 'string', description: 'cover: main headline' },
              subtitle: { type: 'string', description: 'cover: supporting line' },
              index: { type: 'string', description: 'point: big number/marker, e.g. ① or 01' },
              heading: { type: 'string', description: 'point/list/end: card heading' },
              body: { type: 'string', description: 'point/end: paragraph text' },
              tip: { type: 'string', description: 'point/list: highlighted takeaway box at the card bottom' },
              items: { type: 'array', items: { type: 'string' }, description: 'list: bullet items (max 6)' },
            },
            additionalProperties: false,
          },
        },
        theme: { type: 'string', enum: ['warm', 'clean', 'dark', 'tech', 'editorial', 'notebook'], description: 'Visual theme, default warm' },
      },
      required: ['cards'],
    },
    'image.generate_comfyui': {
      properties: {
        prompts: {
          type: 'array',
          description: 'English image prompts, one per image (max 6). Describe the scene only — never ask for text or Chinese characters in the image. Each entry is a string, or an object with "prompt" and optional "negative".',
          items: { type: 'string' },
        },
        style: {
          type: 'string',
          enum: ['illustration', 'photo', 'anime', 'watercolor'],
          description: 'Style preset appended to every prompt, default illustration',
        },
        width: { type: 'integer', description: 'Image width, default 896 (3:4 for Xiaohongshu)' },
        height: { type: 'integer', description: 'Image height, default 1200' },
        steps: { type: 'integer', description: 'Sampling steps 10-40, default 25. Higher is slower.' },
        seed: { type: 'integer', description: 'Optional seed for reproducible output' },
      },
      required: ['prompts'],
    },
    'image.generate_wechat_cover': {
      properties: {
        title: { type: 'string', description: 'Article cover headline' },
        subtitle: { type: 'string', description: 'Optional supporting line' },
        theme: { type: 'string', enum: ['warm', 'clean', 'dark'] },
      },
      required: ['title'],
    },
  };
  const schema = schemaByTool[toolName];
  return {
    type: 'function' as const,
    function: {
      name: modelToolName,
      description: descriptionByTool[toolName] || `Tool: ${toolName}`,
      parameters: schema
        ? { type: 'object' as const, properties: schema.properties, required: schema.required, additionalProperties: false }
        : { type: 'object' as const, properties: {}, additionalProperties: true },
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
const BLOCKED_COMMANDS = /\b(rm\s+-rf\s+\/|sudo|chmod\s+777|curl.*\|\s*(?:sh|bash)|wget.*\|\s*(?:sh|bash)|eval\b|exec\s)|\$\{[^}]+@P\}|\$\{![^}]+\}|\$\(|`/i;

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
  assertLocalShellAllowed();
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

function assertWebToolsEnabled(): void {
  if ((process.env.WEB_TOOLS_ENABLED || '').toLowerCase() === 'false') {
    throw new Error('Web tools are disabled. Set WEB_TOOLS_ENABLED=true to allow web research tools.');
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
  assertWebToolsEnabled();
  assertNetworkToolAllowed('web');
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

function extractTitle(page: string, fallbackUrl: string): string {
  const titleMatch = page.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const raw = titleMatch?.[1]?.replace(/<[^>]+>/g, ' ') || fallbackUrl;
  return compactText(raw, 180);
}

function htmlToReadableText(page: string, limit: number): string {
  const text = page
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  return compactText(text, limit);
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

  if (toolName === 'file_list') {
    try {
      const sub = String(toolInput.path || toolInput.dir || '.');
      const root = assertSafePath(workdir, sub);
      const entries: string[] = [];
      const SKIP = new Set(['node_modules', '.git', 'dist', '.agent-factory']);
      const walk = (dir: string, depth: number) => {
        if (depth > 4 || entries.length >= 500) return;
        for (const name of readdirSync(dir)) {
          if (SKIP.has(name)) continue;
          const full = join(dir, name);
          let st;
          try { st = statSync(full); } catch { continue; }
          const rel = relative(workdir, full);
          if (st.isDirectory()) { entries.push(rel + '/'); walk(full, depth + 1); }
          else entries.push(rel);
          if (entries.length >= 500) return;
        }
      };
      walk(root, 0);
      return { output: capOutput(entries.join('\n') || '(empty)', maxOutputChars), status: 'done' };
    } catch (err: any) {
      return { output: `List failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'media.inspect') {
    try {
      const filePath = assertSafePath(workdir, String(toolInput.path || toolInput.file_path || ''));
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error('Path is not a file');
      const extension = extname(filePath).toLowerCase();
      const result: Record<string, unknown> = {
        path: filePath,
        exists: true,
        size_bytes: stat.size,
        extension,
      };

      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tiff', '.avif'].includes(extension)) {
        const metadata = await sharp(filePath).metadata();
        Object.assign(result, {
          media_type: 'image',
          format: metadata.format || extension.slice(1),
          width: metadata.width,
          height: metadata.height,
          aspect_ratio: metadata.width && metadata.height ? metadata.width / metadata.height : undefined,
          color_space: metadata.space,
          orientation: metadata.orientation,
          has_exif: Boolean(metadata.exif?.length),
          has_icc_profile: Boolean(metadata.icc?.length),
        });
      } else if (['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(extension)) {
        result.media_type = 'video';
        try {
          const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration,format_name,size:stream=index,codec_name,codec_type,width,height',
            '-of', 'json',
            filePath,
          ], {
            cwd: workdir,
            encoding: 'utf-8',
            timeout: Math.min(timeoutMs, 15_000),
            maxBuffer: 512_000,
          });
          result.ffprobe = JSON.parse(stdout);
        } catch (error: any) {
          result.inspect_warning = `ffprobe unavailable or failed: ${error.message || 'unknown error'}`;
        }
      } else {
        result.media_type = 'unknown';
      }

      return { output: capOutput(JSON.stringify(result, null, 2), maxOutputChars), status: 'done' };
    } catch (err: any) {
      return {
        output: JSON.stringify({
          path: String(toolInput.path || toolInput.file_path || ''),
          exists: false,
          error: err.message,
        }),
        status: 'failed',
      };
    }
  }

  if (toolName === 'social.schedule_check') {
    try {
      const workspaceId = options.workspaceId || String(toolInput.workspace_id || 'default');
      if (options.workspaceId && toolInput.workspace_id && toolInput.workspace_id !== options.workspaceId) {
        throw new Error('workspace_id does not match the task workspace');
      }
      const conflicts = findSocialScheduleConflicts({
        workspaceId,
        platform: String(toolInput.platform) as 'douyin' | 'xiaohongshu' | 'wechat',
        accountId: String(toolInput.account_id || ''),
        scheduleAt: String(toolInput.schedule_at || ''),
        windowMinutes: Number(toolInput.window_minutes || 30),
        excludeContentId: toolInput.exclude_content_id
          ? String(toolInput.exclude_content_id)
          : undefined,
      });
      return {
        output: capOutput(JSON.stringify({
          conflict: conflicts.length > 0,
          conflicts,
        }, null, 2), maxOutputChars),
        status: 'done',
      };
    } catch (err: any) {
      return { output: `Schedule check failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'social.monitor_plan') {
    try {
      const workspaceId = options.workspaceId || String(toolInput.workspace_id || 'default');
      if (options.workspaceId && toolInput.workspace_id && toolInput.workspace_id !== options.workspaceId) {
        throw new Error('workspace_id does not match the task workspace');
      }
      const jobs = createSocialMonitorJobs({
        workspaceId,
        contentId: String(toolInput.content_id || ''),
        platform: String(toolInput.platform) as 'douyin' | 'xiaohongshu' | 'wechat',
        publishId: String(toolInput.publish_id || ''),
        publishedAt: String(toolInput.published_at || ''),
      });
      return {
        output: capOutput(JSON.stringify({ jobs }, null, 2), maxOutputChars),
        status: 'done',
      };
    } catch (err: any) {
      return { output: `Monitor plan failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'apply_patch') {
    try {
      const filePath = assertSafePath(workdir, String(toolInput.path || toolInput.file_path || ''));
      const oldStr = String(toolInput.old_str ?? toolInput.find ?? '');
      const newStr = String(toolInput.new_str ?? toolInput.replace ?? '');
      if (!oldStr) throw new Error('apply_patch requires a non-empty old_str');
      if (!existsSync(filePath)) throw new Error(`file not found: ${toolInput.path}`);
      const content = readFileSync(filePath, 'utf-8');
      const idx = content.indexOf(oldStr);
      if (idx === -1) throw new Error('old_str not found in file (it must match exactly, including whitespace)');
      if (content.indexOf(oldStr, idx + oldStr.length) !== -1) {
        throw new Error('old_str matches multiple times; include more surrounding context to make it unique');
      }
      writeFileSync(filePath, content.slice(0, idx) + newStr + content.slice(idx + oldStr.length), 'utf-8');
      const delta = newStr.split('\n').length - oldStr.split('\n').length;
      return { output: capOutput(`Patched ${toolInput.path} (${delta >= 0 ? '+' : ''}${delta} lines)`, maxOutputChars), status: 'done' };
    } catch (err: any) {
      return { output: `Patch failed: ${err.message}`, status: 'failed' };
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

  if (toolName === 'web.extract') {
    try {
      const url = safeUrl(String(toolInput.url || '')).toString();
      const maxChars = Math.min(Number(toolInput.maxChars || 6000), maxOutputChars);
      const page = await fetchText(url, Math.min(timeoutMs, 15_000), Math.max(maxChars * 3, 20_000));
      const title = extractTitle(page, url);
      const content = htmlToReadableText(page, maxChars);
      return {
        output: jsonToolOutput({
          url,
          title,
          content,
          citations: [{ url, title }],
        }, maxOutputChars),
        status: 'done',
      };
    } catch (err: any) {
      return { output: `Extract failed: ${err.message}`, status: 'failed' };
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

  if (toolName === 'content.compliance_check') {
    try {
      const documents = Array.isArray(toolInput.documents) ? toolInput.documents : [];
      if (documents.length === 0) throw new Error('documents must be a non-empty array');
      const workspaceId = options.workspaceId || String(toolInput.workspace_id || 'default');
      if (options.workspaceId && toolInput.workspace_id && toolInput.workspace_id !== options.workspaceId) {
        throw new Error('workspace_id does not match the task workspace');
      }
      const storedRulebook = getActiveSocialComplianceRulebook(workspaceId);
      const resourceRoot = process.env.MYRMECIA_RESOURCE_ROOT || workdir;
      const rulePath = storedRulebook ? undefined : [
        join(resourceRoot, 'docs/social-workflow/compliance-rules.yaml'),
        resolve(workdir, 'docs/social-workflow/compliance-rules.yaml'),
      ].find(existsSync);
      if (!storedRulebook && !rulePath) throw new Error('Social compliance rulebook not found');
      const rulebook = parseYaml(
        storedRulebook?.yaml || readFileSync(rulePath!, 'utf8')
      ) as {
        rules?: Array<{
          id: string;
          severity: 'blocker' | 'warning' | 'info';
          platforms?: string[];
          patterns?: string[];
          checks?: string[];
          message?: string;
        }>;
      };
      const findings: Array<Record<string, unknown>> = [];

      for (const document of documents) {
        const platform = String(document.platform || '');
        const title = String(document.title || '');
        const body = String(document.body || document.text || '');
        const text = `${title}\n${body}`;
        for (const rule of rulebook.rules || []) {
          if (rule.platforms?.length && !rule.platforms.includes(platform)) continue;
          for (const pattern of rule.patterns || []) {
            let regex: RegExp;
            try {
              regex = new RegExp(pattern, 'giu');
            } catch {
              regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
            }
            const matches = Array.from(text.matchAll(regex)).map(match => match[0]).slice(0, 10);
            if (matches.length > 0) {
              findings.push({
                rule_id: rule.id,
                severity: rule.severity,
                platforms: [platform],
                evidence: matches.join(', '),
                recommendation: rule.message || '需要人工复核',
                confidence: 1,
              });
            }
          }

          for (const check of rule.checks || []) {
            const failed = (
              check === 'title_max_20_chars' && title.length > 20
            ) || (
              check === 'body_max_1000_chars' && body.length > 1000
            ) || (
              check === 'hook_within_3_seconds' && !/(0[-–~至]3秒|前3秒|hook)/i.test(text)
            ) || (
              check === 'html_layout_required' && !/<(?:section|p|h[1-6])\b/i.test(body)
            );
            if (failed) {
              findings.push({
                rule_id: rule.id,
                severity: rule.severity,
                platforms: [platform],
                evidence: check,
                recommendation: rule.message || '需要人工复核',
                confidence: 1,
              });
            }
          }
        }
      }

      const status = findings.some(item => item.severity === 'blocker')
        ? 'blocked'
        : findings.some(item => item.severity === 'warning')
          ? 'needs_revision'
          : 'pass';
      return {
        output: capOutput(JSON.stringify({
          schema_version: '1.0',
          content_id: String(toolInput.content_id || ''),
          status,
          summary: `Deterministic rule check completed with ${findings.length} finding(s).`,
          findings,
          required_human_checks: ['事实来源、素材版权和平台最新规则仍需人工确认'],
          reviewed_at: new Date().toISOString(),
        }, null, 2), maxOutputChars),
        status: 'done',
      };
    } catch (err: any) {
      return { output: `Compliance check failed: ${err.message}`, status: 'failed' };
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

  if (toolName === 'image.generate_cards') {
    try {
      const spec = toolInput as unknown as CardRenderSpec;
      const outDir = assertSafePath(workdir, 'generated-assets/cards');
      const { paths, chromeBinary } = await renderCards(spec, outDir, { timeoutMs: Math.min(timeoutMs, 60_000) });
      return {
        output: jsonToolOutput({
          paths,
          count: paths.length,
          format: 'png',
          size: `${CARD_WIDTH}x${CARD_HEIGHT}`,
          renderer: chromeBinary,
          note: 'These are absolute paths to real PNG files — pass them directly as the "images" argument when publishing.',
        }, maxOutputChars),
        status: 'done',
      };
    } catch (err: any) {
      return { output: `Image card generation failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'image.generate_comfyui') {
    try {
      const spec = toolInput as unknown as ComfyGenerateSpec;
      const outDir = assertSafePath(workdir, 'generated-assets/art');
      const result = await generateComfyImages(spec, outDir, {
        timeoutMs,
        onProgress: (p) => options.onProgress?.({ message: p.message, ratio: p.ratio }),
      });
      return {
        output: jsonToolOutput({
          paths: result.images.map((img) => img.path),
          count: result.images.length,
          format: 'png',
          model: result.model,
          elapsedSeconds: Math.round(result.elapsedMs / 1000),
          seeds: result.images.map((img) => img.seed),
          autoStarted: result.autoStarted,
          note: 'Absolute paths to real PNG files — pass them directly as the "images" argument when publishing.',
        }, maxOutputChars),
        status: 'done',
      };
    } catch (err: any) {
      return { output: `ComfyUI image generation failed: ${err.message}`, status: 'failed' };
    }
  }

  if (toolName === 'image.generate_wechat_cover') {
    try {
      const outDir = assertSafePath(workdir, 'generated-assets/wechat');
      const { path, renderer } = await renderWeChatCover(
        toolInput as unknown as WeChatCoverSpec,
        outDir,
        { timeoutMs: Math.min(timeoutMs, 60_000) },
      );
      return {
        output: jsonToolOutput({
          path,
          format: 'png',
          size: `${WECHAT_COVER_WIDTH}x${WECHAT_COVER_HEIGHT}`,
          renderer,
          note: 'Upload this PNG through wechat_permanent_media before creating the draft.',
        }, maxOutputChars),
        status: 'done',
      };
    } catch (err: any) {
      return { output: `WeChat cover generation failed: ${err.message}`, status: 'failed' };
    }
  }

  return { output: `Tool "${toolName}" is not available in skill executor sandbox.`, status: 'failed' };
}
