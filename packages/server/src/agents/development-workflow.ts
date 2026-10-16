import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AgentDefinition, Task } from '../types.js';
import { BUILTIN_TOOLS } from '../tools/tool-registry.js';
import { isSimpleConversation } from './conversation-intent.js';

export const SYSTEM_DESIGN_PATH = 'docs/development-plan.json';
export const UI_DESIGN_PATH = 'docs/ui-design.json';
const MAX_DESIGN_BYTES = 32_000;
export const EXPLORATION_WARNING = 6;
export const EXPLORATION_LIMIT = 12;
const reads = new Set(['file_read', 'file_list', 'grep', 'search']);
const writes = new Set(['file_write', 'apply_patch']);
const placeholder = /^(?:todo|tbd|placeholder|待补充|待定)[.。]?$/i;

/** Only host-owned built-in metadata, never an agent-supplied readOnly flag. */
function explorationTool(tool: string): boolean {
  return reads.has(tool) || BUILTIN_TOOLS.some(item => item.id === tool && item.metadata?.readOnly === true);
}

type DevelopmentTask = Pick<Task, 'input' | 'description'>
  & Partial<Pick<Task, 'id' | 'title' | 'mode' | 'pipelineId' | 'parentTaskId' | 'createdBy'>>;
export interface DevelopmentProfile {
  kind: 'none' | 'verification' | 'incremental' | 'system' | 'ui';
  taskId?: string;
  designPaths: string[];
}

/** Intent controls delivery policy, never permissions. Only trust server-owned continuation metadata. */
export function developmentRequest(task: DevelopmentTask): string {
  if (task.parentTaskId && task.createdBy === 'user'
    && task.input.startsWith('Continue the conversation below and answer the NEW user message.')
    && task.input.includes(`Session root: ${task.parentTaskId}\n\n`)
    && task.input.trim().endsWith(`NEW user message:\n${task.description.trim()}`)) return task.description.trim();
  return task.input.trim() || task.description.trim();
}

export function developmentProfile(
  agent: Pick<AgentDefinition, 'id' | 'role'>,
  task?: DevelopmentTask,
): DevelopmentProfile {
  const base = { taskId: task?.id, designPaths: [] as string[] };
  if (!task || !/^(dev|developer|frontend|fullstack|full-stack)$/i.test(agent.role)) return { ...base, kind: 'none' };
  if (isSimpleConversation({ ...task, title: task.title || task.input, mode: task.mode || 'direct' })) {
    return { ...base, kind: 'none' };
  }
  const request = developmentRequest(task);
  const positiveRequest = request
    .replace(/\b(?:do not|don't|never)\s+(?:build|create|develop|implement|add|redesign|refactor|change|modify)\b[^,.;\n]*/gi, '')
    .replace(/(?:不要|不准|不得)(?:开发|创建|实现|新增|修改|重构|优化)[^，。；\n]*/gu, '');
  const mutation = /\b(?:fix|implement|build|create|develop|add|redesign|refactor|change|modify)\b|修复|实现|开发|新增|改动|修改|重构|优化/i.test(positiveRequest);
  if (/^(?:read[- ]only\b|只读|only (?:verify|inspect|review)\b|仅(?:验证|查看|审查))/i.test(request)
    || /\bno code changes\b|\bdo not (?:modify|edit) (?:any |the )?(?:files|code)\b|(?:不要|不准|不得)修改任何/i.test(request)
    || (!mutation && /^(?:(?:review|inspect|explain|analy[sz]e)\b|(?:帮我)?(?:评审|审查|解释|分析))/i.test(request))) return { ...base, kind: 'verification' };
  // Repair children contain the old goal and code snapshot. They repair existing design, not start a new product.
  if (task.createdBy === 'master' && task.parentTaskId && /^fix:/i.test(task.title || '')) return { ...base, kind: 'incremental' };
  // The platform must not add docs outside an explicit file-only write scope.
  // In this case the brief is in the response and its quality remains human-reviewed.
  const explicitFileScope = /\bonly (?:modify|edit|change|write)\b|\ballowed (?:files|paths)\b|只(?:允许|能|可)?(?:修改|操作|编写)|仅(?:修改|改动)/i.test(request);
  if (explicitFileScope
    && !request.includes(SYSTEM_DESIGN_PATH) && !request.includes(UI_DESIGN_PATH)) return { ...base, kind: 'incremental' };
  const system = /\b(?:build|create|develop|implement)\b.{0,80}\b(?:complete|full|entire|end.to.end)\b.{0,60}\b(?:system|application|platform|app|website|product|library|sdk)\b/i.test(positiveRequest)
    || /\b(?:build|create|develop)\b.{0,60}\b(?:system|platform|application|app|website|task board)\b/i.test(positiveRequest)
    || /(?:开发|实现|构建|搭建|做|完成).{0,40}(?:完整|整套|全栈|从零).{0,30}(?:系统|平台|网站|应用|产品)/u.test(positiveRequest)
    || /(?:从零|从头).{0,20}(?:开发|实现|构建|搭建|做).{0,30}(?:系统|平台|网站|应用|产品)/u.test(positiveRequest)
    || /(?:开发|构建|搭建).{0,30}(?:系统|平台|网站|应用)/u.test(positiveRequest);
  const frontend = /\b(?:react|vue|svelte|website|dashboard|interface|frontend|front.end|ui|page)\b|界面|页面|前端|网站|看板/i.test(positiveRequest);
  const backendOnly = /\b(?:backend.only|api.only|headless|cli.only)\b|纯后端|仅后端|不需要(?:前端|界面)|无需(?:前端|界面)/i.test(request)
    || (!frontend && /\b(?:cli|command.line|library|sdk)\b|命令行/i.test(positiveRequest));
  if (system) {
    const designPaths = [SYSTEM_DESIGN_PATH, ...(backendOnly ? [] : [UI_DESIGN_PATH])];
    if (explicitFileScope && !designPaths.every(path => request.includes(path))) return { ...base, kind: 'incremental' };
    return { ...base, kind: 'system', designPaths };
  }
  const ui = /\b(?:build|create|design|redesign|implement|add)\b.{0,60}\b(?:page|dashboard|website|interface|frontend|front.end|ui)\b/i.test(positiveRequest)
    || /(?:设计|重构|重做|实现|开发|新增|添加|优化).{0,35}(?:界面|页面|前端|看板|网站|UI)/i.test(positiveRequest);
  const requireUi = ui && !backendOnly && (!explicitFileScope || request.includes(UI_DESIGN_PATH));
  return { ...base, kind: requireUi ? 'ui' : 'incremental', designPaths: requireUi ? [UI_DESIGN_PATH] : [] };
}

const text = z.string().trim().min(5).max(1600).refine(
  value => !placeholder.test(value), 'Replace placeholder text with a concrete decision',
);
const label = z.string().trim().min(1).max(200).refine(value => !placeholder.test(value), 'Replace placeholder labels');
const labels = z.array(label).min(1).max(30);
const sourcePath = label.refine(path => !isAbsolute(path) && !path.includes('\\')
  && !path.split('/').some(part => !part || part === '..' || part.startsWith('.'))
  && /\.(?:[cm]?jsx?|tsx?|vue|svelte|html|css|scss|py|go|rs|sql|java|cs|swift|rb|php|c|cpp|h|sh)$/i.test(path),
'Declare a relative implementation source path, not a secret, design file, output archive or directory');
const sources = z.array(sourcePath).min(1).max(30);
const systemSchema = z.object({
  schemaVersion: z.literal(1), taskId: label, summary: text, users: labels,
  flows: z.array(z.object({ name: label, steps: z.array(text).min(2).max(15) }).strict()).min(1).max(15),
  modules: z.array(z.object({ name: label, responsibility: text, interfaces: labels, sourceFiles: sources }).strict()).min(1).max(20),
  dataStrategy: text,
  acceptance: z.array(z.object({ id: label, description: text,
    evidence: z.enum(['tests', 'build', 'browser', 'visual_review', 'manual']) }).strict()).min(1).max(30),
  milestones: z.array(z.object({ name: label, deliverables: labels, checks: labels }).strict()).min(2).max(12),
  risks: z.array(text).max(20),
}).strict();
const color = z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
const uiSchema = z.object({
  schemaVersion: z.literal(1), taskId: label, visualDirection: text,
  colors: z.object({ background: color, foreground: color, accent: color }).strict(),
  typography: z.object({ family: label, hierarchy: text }).strict(),
  layout: z.object({ navigation: text, primaryAction: text, desktop: text, mobile: text }).strict(),
  screens: z.array(z.object({ name: label, purpose: text, components: labels, sourceFiles: sources,
    states: z.object({ loading: text, empty: text, error: text, success: text }).strict() }).strict()).min(1).max(15),
  interactions: z.array(text).min(1).max(30),
  accessibility: z.object({ keyboard: text, focus: text, contrast: text, reducedMotion: text }).strict(),
}).strict();

export interface DesignCheck {
  valid: boolean;
  errors: string[];
  sourceFiles: string[];
}
export function validateDesignContent(path: string, content: string, taskId?: string): DesignCheck {
  const invalid = (error: string): DesignCheck => ({ valid: false, errors: [error], sourceFiles: [] });
  if (!taskId) return invalid('The design must be bound to a persisted task ID');
  if (Buffer.byteLength(content) > MAX_DESIGN_BYTES) return invalid(`Design exceeds ${MAX_DESIGN_BYTES} bytes`);
  let value: unknown;
  try { value = JSON.parse(content); } catch { return invalid('Design must be valid JSON, not prose or fenced Markdown'); }
  const schema = path === SYSTEM_DESIGN_PATH ? systemSchema : path === UI_DESIGN_PATH ? uiSchema : undefined;
  if (!schema) return invalid('Unknown design artifact path');
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { valid: false, sourceFiles: [],
    errors: parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join('.')}: ${issue.message}`) };
  if (parsed.data.taskId !== taskId) return invalid('Design taskId does not match this task; do not reuse a stale design');
  const sourceFiles = 'modules' in parsed.data
    ? parsed.data.modules.flatMap(module => module.sourceFiles)
    : parsed.data.screens.flatMap(screen => screen.sourceFiles);
  return { valid: true, errors: [], sourceFiles: [...new Set(sourceFiles)] };
}

/** Bounded reads of declared artifacts only. Symlinks, dot paths and parent traversal fail closed. */
function readArtifact(workdir: string, path: string, design: boolean): { sha256: string; content?: string } {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '..' || part.startsWith('.'))) {
    throw new Error('Artifact path must stay within the task workspace');
  }
  const root = realpathSync(workdir), resolved = resolve(root, path);
  if (!resolved.startsWith(root + sep)) throw new Error('Artifact path escapes the task workspace');
  let current = root;
  const parts = path.split(/[\\/]/);
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Artifact symlinks are not accepted');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Artifact parent is not a directory');
    if (index === parts.length - 1 && (!stat.isFile() || stat.size === 0
      || stat.size > (design ? MAX_DESIGN_BYTES : 1_000_000))) throw new Error('Artifact must be a non-empty bounded regular file');
  }
  const bytes = readFileSync(resolved);
  if (!bytes.toString('utf8').trim()) throw new Error('Artifact contains only whitespace');
  return { sha256: createHash('sha256').update(bytes).digest('hex'), ...(design ? { content: bytes.toString('utf8') } : {}) };
}

export function checkDevelopmentArtifacts(profile: DevelopmentProfile, workdir: string, includeSources = false, excludeSources: string[] = []) {
  const errors: string[] = [], verified: Array<{ path: string; sha256: string }> = [], sources = new Set<string>();
  for (const path of profile.designPaths) {
    try {
      const artifact = readArtifact(workdir, path, true);
      const check = validateDesignContent(path, artifact.content!, profile.taskId);
      if (!check.valid) errors.push(...check.errors.map(error => `${path}: ${error}`));
      else { verified.push({ path, sha256: artifact.sha256 }); check.sourceFiles.forEach(source => sources.add(source)); }
    } catch { errors.push(`${path}: missing, empty, unsafe or oversized artifact`); }
  }
  if (includeSources && !errors.length) {
    for (const path of sources) {
      if (excludeSources.includes(path)) continue;
      try { verified.push({ path, sha256: readArtifact(workdir, path, false).sha256 }); }
      catch { errors.push(`${path}: declared implementation source is missing, empty, unsafe or oversized`); }
    }
  }
  return { valid: errors.length === 0, errors, verified, sourceFiles: [...sources],
    // A schema and file presence check is deliberately not a visual, test or production acceptance.
    evidenceScope: includeSources ? 'design_schema_and_declared_files' : 'design_schema' };
}

export function developmentPrompt(profile: DevelopmentProfile): string {
  if (profile.kind === 'none') return '';
  if (profile.kind === 'verification') return `## Host development verification protocol
This is review/verification, not implementation. Do not execute a skill's code-writing, redesign or refactoring stages.
Do not create design files or implementation changes. Perform only checks actually authorized by this request and the existing tool policy.
Report findings and real evidence; do not claim code changes, browser acceptance or production readiness without proof.
If a fix is required, explain it and wait for the user's instruction to implement it.`;
  const parts = [`## Host development delivery protocol
Scope: ${profile.kind}${profile.designPaths.length ? `; taskId: ${profile.taskId || 'the persisted runtime task ID'}` : ''}.
You own an integrated user workflow, not merely "minimal code that makes tests pass".
Respect the existing stack, working directory, write scope and design system. Do not invent pages, dependencies, permissions or identities.
Distinguish implementation, real tests/build, browser behavior and human visual acceptance. Schema validity is not design quality.
If browser tools are unavailable, say UI/visual acceptance is unverified; do not invent screenshots or a pass.
Read only the relevant files/pages, then produce a concrete design or code change. Use bounded file_read offset/maxChars/expectedSha256.
Authorized host-known read-only reference tools remain available before design; unknown/MCP effects require the design first. This protocol grants no tool permissions.
After 6 consecutive exploration calls the host redirects you; 12 without a successful write stops the run.
Failed patches, empty answers and repeated old tests are not progress. After a patch mismatch reread its exact block, not the whole project.
For incremental changes preserve existing flows, data, tests and style; update affected interfaces and verify regressions.`];
  if (profile.designPaths.length) {
    parts.push(`Before implementation or Shell, use file_write to create these real JSON artifacts: ${profile.designPaths.join(', ')}.
Bind taskId exactly to ${profile.taskId || 'the persisted task ID'}. No fenced JSON, placeholders or fake completed checks.
Do not start a multi-page system by writing a single page. Define the user flows, boundaries and all required deliverables first.
Complete the declared source files before claiming delivery. Read-before-write and tool permissions still apply.
Make reasonable bounded assumptions and record risks; ask only for choices that materially change scope or require new authority.`);
  }
  if (profile.designPaths.includes(SYSTEM_DESIGN_PATH)) parts.push(`System plan shape:
{schemaVersion:1,taskId,summary,users:[string],flows:[{name,steps:[string,string]}],
modules:[{name,responsibility,interfaces:[string],sourceFiles:[relative source path]}],dataStrategy,
acceptance:[{id,description,evidence:"tests"|"build"|"browser"|"visual_review"|"manual"}],
milestones:[{name,deliverables:[string],checks:[string]},{name,deliverables:[string],checks:[string]}],risks:[string]}.
Cover authentication/data persistence only when in scope; document API/error behavior, module ownership and end-to-end acceptance.`);
  if (profile.designPaths.includes(UI_DESIGN_PATH)) parts.push(`UI design shape:
{schemaVersion:1,taskId,visualDirection,colors:{background:"#...",foreground:"#...",accent:"#..."},
typography:{family,hierarchy},layout:{navigation,primaryAction,desktop,mobile},
screens:[{name,purpose,components:[string],sourceFiles:[relative source path],states:{loading,empty,error,success}}],
interactions:[string],accessibility:{keyboard,focus,contrast,reducedMotion}}.
Use concrete decisions (at least 5 characters), one coherent palette and hierarchy, responsive behavior and complete interactive states.
Use references when authorized; inherit an existing product's components rather than default unstyled forms. Do not add marketing images or decorative effects to a working dashboard without a task reason.`);
  return parts.join('\n\n');
}

/** Runs on every tool callback, including SDK-native inner loops whose outer model turn stays at 1. */
export class DevelopmentWorkflow {
  readonly profile: DevelopmentProfile;
  private exploration = 0;
  private pendingExploration = 0;
  private designRefusals = 0;
  private guidance = '';
  constructor(agent: Pick<AgentDefinition, 'id' | 'role'>, task: DevelopmentTask) {
    this.profile = developmentProfile(agent, task);
  }
  beforeTool(tool: string, input: Record<string, unknown>, workdir: string) {
    if (this.profile.kind === 'none' || this.profile.kind === 'verification') return { allowed: true };
    if (explorationTool(tool) && this.exploration + this.pendingExploration >= EXPLORATION_LIMIT) {
      return { allowed: false, terminal: true,
        reason: `DEVELOPMENT_EXPLORATION_LIMIT: ${this.exploration + this.pendingExploration} completed/reserved exploration calls without a successful write. Preserve partial work; narrow the next step rather than retrying the same exploration.` };
    }
    if (explorationTool(tool)) {
      // Reserve synchronously so concurrent SDK callbacks cannot all pass the same counter.
      this.pendingExploration++;
      return { allowed: true };
    }
    if (!this.profile.designPaths.length) return { allowed: true };
    const requestedPath = input.path ?? input.file_path;
    const path = typeof requestedPath === 'string' ? relative(resolve(workdir), resolve(workdir, requestedPath)).replaceAll('\\', '/') : '';
    if (tool === 'file_write' && this.profile.designPaths.includes(path)) {
      const check = validateDesignContent(path, typeof input.content === 'string' ? input.content : '', this.profile.taskId);
      if (check.valid) return { allowed: true };
      return this.refuse(`Invalid ${path}: ${check.errors.join('; ')}`);
    }
    if (tool === 'apply_patch' && this.profile.designPaths.includes(path)) return { allowed: true };
    const artifacts = checkDevelopmentArtifacts(this.profile, workdir);
    return artifacts.valid ? { allowed: true } : this.refuse(`Write the required design JSON with file_write first. ${artifacts.errors.join('; ')}`);
  }
  afterTool(tool: string, status: 'done' | 'failed', output: string, input: Record<string, unknown> = {}) {
    if (this.profile.kind === 'none' || this.profile.kind === 'verification') return;
    const changed = tool === 'file_write' ? typeof input.content === 'string' && input.content.trim().length > 0
      : typeof input.old_str === 'string' && typeof input.new_str === 'string' && input.old_str !== input.new_str;
    if (writes.has(tool) && changed && status === 'done' && /^(?:Written:|Patched )/.test(output)) {
      this.exploration = 0; this.designRefusals = 0; this.guidance = '';
    } else if (explorationTool(tool)) {
      this.pendingExploration = Math.max(0, this.pendingExploration - 1);
      this.exploration++;
      if (this.exploration === EXPLORATION_WARNING || this.exploration === EXPLORATION_LIMIT - 2) {
        this.guidance = `DEVELOPMENT_EXPLORATION_CHECKPOINT: ${this.exploration}/${EXPLORATION_LIMIT} consecutive exploration calls.
Synthesize the current findings and write the applicable design or a focused implementation/test change now.
Do not reread old tests, repeat directory discovery or run old tests merely to avoid implementation.
If a required read remains, read only its exact block. Never bypass the design, permission or read-before-write gates.`;
      }
    }
  }
  modelResult(output: string): string {
    const guidance = this.guidance; this.guidance = '';
    if (!guidance) return output;
    // Keep paginated file_read packets machine-readable; never remove content/offset/hash fields.
    try {
      const packet: unknown = JSON.parse(output);
      if (packet && typeof packet === 'object' && !Array.isArray(packet)) {
        return JSON.stringify({ ...packet, hostDevelopmentGuidance: guidance });
      }
    } catch { /* plain text tool output */ }
    return `${output}\n\n[Host development guidance]\n${guidance}`;
  }
  private refuse(message: string) {
    this.designRefusals++;
    return { allowed: false, terminal: this.designRefusals >= 3,
      reason: `DEVELOPMENT_DESIGN_INCOMPLETE: ${message}` };
  }
}
