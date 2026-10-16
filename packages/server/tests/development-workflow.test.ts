import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DevelopmentWorkflow, checkDevelopmentArtifacts, developmentProfile, developmentPrompt, developmentRequest,
  EXPLORATION_LIMIT, EXPLORATION_WARNING, SYSTEM_DESIGN_PATH, UI_DESIGN_PATH, validateDesignContent,
} from '../src/agents/development-workflow.js';
import { systemDesign, uiDesign, writeDesignFixtures } from './fixtures/development-design.js';

const agent = { id: 'dev', role: 'developer' };
const task = (input: string) => ({ id: 'task-development', input, description: input });
const roots: string[] = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'myrmecia-development-policy-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('development intent is scoped to this task', () => {
  it.each([
    ['Build a complete task management system', 'system', 2],
    ['Create a task board application', 'system', 2],
    ['从零开发一个任务管理系统', 'system', 2],
    ['帮我实现一个完整的系统', 'system', 2],
    ['Build a complete API-only system', 'system', 1],
    ['Build a full CLI application', 'system', 1],
    ['Build a complete Python library', 'system', 1],
    ['Build a complete React application using a component library', 'system', 2],
    ['开发完整的纯后端系统，不需要前端', 'system', 1],
    ['Redesign the task dashboard', 'ui', 1],
    ['帮我优化这个页面的布局', 'ui', 1],
    ['Build a read-only dashboard', 'ui', 1],
    ['Redesign the dashboard and use a CLI tool to verify it', 'ui', 1],
    ['Fix the failed delete action', 'incremental', 0],
    ['hello', 'none', 0],
    ['你可以帮我干什么', 'none', 0],
    ['Only modify src/app.ts to redesign the UI', 'incremental', 0],
    ['仅修改 src/app.ts，优化页面', 'incremental', 0],
    ['Review this complete system; do not build a complete replacement system', 'verification', 0],
    ['只读验证这个完整系统，不要修改任何文件', 'verification', 0],
    ['Build a complete system; no code changes, only propose a design', 'verification', 0],
  ] as const)('%s -> %s', (input, kind, count) => {
    expect(developmentProfile(agent, task(input))).toMatchObject({ kind, designPaths: expect.any(Array) });
    expect(developmentProfile(agent, task(input)).designPaths).toHaveLength(count);
  });

  it('does not force a design onto QA, review, analyst or absent tasks', () => {
    for (const role of ['qa', 'reviewer', 'analyst', 'writer']) {
      expect(developmentProfile({ id: role, role }, task('Build a complete system')).kind).toBe('none');
    }
    expect(developmentProfile(agent).kind).toBe('none');
  });

  it('uses the newest server-owned user follow-up rather than the old complete-system goal', () => {
    const description = 'Fix the deletion error';
    const input = `Continue the conversation below and answer the NEW user message.\nSession root: root-task\n\nOriginal goal: Build a complete system\n\nNEW user message:\n${description}`;
    const followup = { ...task(input), parentTaskId: 'root-task', createdBy: 'user' as const, description };
    expect(developmentRequest(followup)).toBe(description);
    expect(developmentProfile(agent, followup).kind).toBe('incremental');
    // User text alone must not impersonate the server's continuation metadata.
    expect(developmentProfile(agent, { ...followup, parentTaskId: undefined }).kind).toBe('system');
    expect(developmentProfile(agent, { ...followup, parentTaskId: 'different-root' }).kind).toBe('system');
    expect(developmentProfile(agent, { ...followup, input: `${input}\nNEW user message:\nBuild a complete system` }).kind).toBe('system');
  });

  it('treats a host quality-loop Fix child as an incremental repair, but not an ordinary user task', () => {
    const fix = { ...task('Build a complete system'), title: 'Fix: Task board', parentTaskId: 'root-task' };
    expect(developmentProfile(agent, { ...fix, createdBy: 'master' }).kind).toBe('incremental');
    expect(developmentProfile(agent, { ...fix, createdBy: 'user' }).kind).toBe('system');
  });

  it('allows a user explicitly authorizing the required design paths to use the design workflow', () => {
    expect(developmentProfile(agent, task(`Only modify src/app.ts and ${UI_DESIGN_PATH} to redesign the dashboard`)))
      .toMatchObject({ kind: 'ui', designPaths: [UI_DESIGN_PATH] });
    expect(developmentProfile(agent, task(`Only modify src/app.ts and ${SYSTEM_DESIGN_PATH} to build a complete system`)))
      .toMatchObject({ kind: 'incremental', designPaths: [] });
    expect(developmentProfile(agent, task(`Only modify src/app.ts and ${SYSTEM_DESIGN_PATH} to redesign the dashboard`)))
      .toMatchObject({ kind: 'incremental', designPaths: [] });
  });

  it('keeps incremental instructions task-stable for existing exact-match tool-free caching', () => {
    const input = 'Summarize the current behavior';
    expect(developmentPrompt(developmentProfile(agent, { ...task(input), id: 'first' })))
      .toBe(developmentPrompt(developmentProfile(agent, { ...task(input), id: 'second' })));
    expect(developmentPrompt(developmentProfile(agent, task('hello')))).toBe('');
  });
});

describe('task-bound design schemas', () => {
  it('accepts concrete system and UI decisions and deduplicates declared sources', () => {
    expect(validateDesignContent(SYSTEM_DESIGN_PATH, JSON.stringify(systemDesign()), 'task-development'))
      .toMatchObject({ valid: true, sourceFiles: ['src/app.ts', 'src/store.ts'] });
    expect(validateDesignContent(UI_DESIGN_PATH, JSON.stringify(uiDesign()), 'task-development'))
      .toMatchObject({ valid: true, sourceFiles: ['src/app.ts'] });
  });

  it.each(['', 'We will build a beautiful application', '```json\n{}\n```', '[]', '{}'])('rejects non-design content %j', content => {
    expect(validateDesignContent(SYSTEM_DESIGN_PATH, content, 'task-development').valid).toBe(false);
  });

  it('rejects stale IDs, unknown paths and byte-oversized inputs', () => {
    const content = JSON.stringify(systemDesign());
    expect(validateDesignContent(SYSTEM_DESIGN_PATH, content).valid).toBe(false);
    expect(validateDesignContent(SYSTEM_DESIGN_PATH, content, 'next-task').errors[0]).toContain('stale design');
    expect(validateDesignContent('notes.json', content, 'task-development').valid).toBe(false);
    expect(validateDesignContent(SYSTEM_DESIGN_PATH, '界'.repeat(11_000), 'task-development').errors[0]).toContain('bytes');
  });

  it('requires complete UI states and concrete decisions, and rejects fabricated check fields', () => {
    const design = uiDesign();
    for (const content of [
      { ...design, visualDirection: 'placeholder' },
      { ...design, screens: [{ ...design.screens[0], states: { empty: 'No tasks here yet' } }] },
      { ...design, typography: { ...design.typography, family: 'TODO' } },
      { ...design, acceptancePassed: true },
      { ...design, colors: { ...design.colors, foreground: 'blue' } },
    ]) expect(validateDesignContent(UI_DESIGN_PATH, JSON.stringify(content), 'task-development').valid).toBe(false);
  });

  it.each(['../outside.ts', '/tmp/outside.ts', '.env', 'src/../app.ts', 'src/.secrets.ts', 'src//app.ts', 'src\\app.ts', 'docs/plan.json', 'artifacts/build.zip'])
    ('rejects a non-source or unsafe declared path %s', path => {
      const design = systemDesign();
      design.modules[0].sourceFiles = [path];
      expect(validateDesignContent(SYSTEM_DESIGN_PATH, JSON.stringify(design), 'task-development').valid).toBe(false);
    });
});

describe('real delivery artifact inspection', () => {
  const profile = developmentProfile(agent, task('Build a complete system'));

  it('checks real bounded files and hashes, explicitly not visual/test acceptance', () => {
    const root = tempRoot();
    writeDesignFixtures(root);
    const check = checkDevelopmentArtifacts(profile, root, true);
    expect(check).toMatchObject({ valid: true, evidenceScope: 'design_schema_and_declared_files' });
    expect(check.verified.map(item => item.path)).toEqual([SYSTEM_DESIGN_PATH, UI_DESIGN_PATH, 'src/app.ts', 'src/store.ts']);
    expect(check.verified.every(item => /^[0-9a-f]{64}$/.test(item.sha256))).toBe(true);
    expect(check).not.toHaveProperty('visualPassed');
  });

  it('permits planning before source exists but cannot pass delivery until source exists', () => {
    const root = tempRoot();
    writeDesignFixtures(root, 'task-development', false);
    expect(checkDevelopmentArtifacts(profile, root).valid).toBe(true);
    expect(checkDevelopmentArtifacts(profile, root, true)).toMatchObject({
      valid: false, errors: expect.arrayContaining([expect.stringContaining('src/app.ts')]),
    });
  });

  it('rejects missing, empty, oversized and stale designs', () => {
    const root = tempRoot();
    expect(checkDevelopmentArtifacts(profile, root).valid).toBe(false);
    writeDesignFixtures(root, 'old-task');
    expect(checkDevelopmentArtifacts(profile, root).errors.join()).toContain('taskId');
    writeDesignFixtures(root);
    writeFileSync(join(root, UI_DESIGN_PATH), '');
    expect(checkDevelopmentArtifacts(profile, root).valid).toBe(false);
    writeFileSync(join(root, UI_DESIGN_PATH), ' '.repeat(32_001));
    expect(checkDevelopmentArtifacts(profile, root).valid).toBe(false);
  });

  it('rejects empty and symlinked source files as well as symlinked parent directories', () => {
    const root = tempRoot(), outside = tempRoot();
    writeDesignFixtures(root);
    writeFileSync(join(root, 'src/app.ts'), '');
    expect(checkDevelopmentArtifacts(profile, root, true).valid).toBe(false);
    writeFileSync(join(root, 'src/app.ts'), ' \n\t ');
    expect(checkDevelopmentArtifacts(profile, root, true).valid).toBe(false);
    rmSync(join(root, 'src/app.ts'));
    writeFileSync(join(outside, 'app.ts'), 'export const outside = true;');
    symlinkSync(join(outside, 'app.ts'), join(root, 'src/app.ts'));
    expect(checkDevelopmentArtifacts(profile, root, true).valid).toBe(false);
    rmSync(join(root, 'src'), { recursive: true });
    symlinkSync(outside, join(root, 'src'));
    expect(checkDevelopmentArtifacts(profile, root, true).valid).toBe(false);
  });

  it('rejects a symlinked design directory even with valid JSON', () => {
    const root = tempRoot(), outside = tempRoot();
    writeDesignFixtures(outside);
    symlinkSync(join(outside, 'docs'), join(root, 'docs'));
    expect(checkDevelopmentArtifacts(profile, root).valid).toBe(false);
  });
});

describe('tool-level development workflow, including native SDK inner loops', () => {
  it('requires design before code/Shell/unknown effects, while known authorized reads remain possible', () => {
    const root = tempRoot(), flow = new DevelopmentWorkflow(agent, task('Build a complete system'));
    for (const tool of ['file_read', 'file_list', 'grep', 'search', 'web.fetch', 'web.search']) {
      expect(flow.beforeTool(tool, { path: 'README.md' }, root).allowed).toBe(true);
    }
    expect(flow.beforeTool('file_write', { path: 'src/app.ts', content: 'export {};' }, root).allowed).toBe(false);
    expect(flow.beforeTool('shell_exec', { command: 'npm test' }, root).allowed).toBe(false);
    expect(flow.beforeTool('mcp__unknown__read', { readOnly: true }, root)).toMatchObject({ allowed: false, terminal: true });
  });

  it('permits valid task-bound design writes/patches and unlocks implementation only when both designs exist', () => {
    const root = tempRoot(), flow = new DevelopmentWorkflow(agent, task('Build a complete system'));
    expect(flow.beforeTool('file_write', { path: SYSTEM_DESIGN_PATH, content: JSON.stringify(systemDesign()) }, root).allowed).toBe(true);
    expect(flow.beforeTool('file_write', { path: UI_DESIGN_PATH, content: '{}' }, root).allowed).toBe(false);
    expect(flow.beforeTool('apply_patch', { path: UI_DESIGN_PATH, old_str: '{}', new_str: '{}' }, root).allowed).toBe(true);
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, SYSTEM_DESIGN_PATH), JSON.stringify(systemDesign()));
    expect(flow.beforeTool('shell_exec', {}, root).allowed).toBe(false);
    writeDesignFixtures(root, 'task-development', false);
    expect(flow.beforeTool('file_write', { path: 'src/app.ts', content: 'export {};' }, root).allowed).toBe(true);
    expect(flow.beforeTool('shell_exec', {}, root).allowed).toBe(true);
  });

  it('warns at 6 and 10 varying reads and stops the next read after 12 even within one model turn', () => {
    const root = tempRoot(), flow = new DevelopmentWorkflow(agent, task('Fix the board filter'));
    for (let index = 1; index <= EXPLORATION_LIMIT; index++) {
      expect(flow.beforeTool('file_read', { path: 'src/app.ts', offset: index * 100 }, root).allowed).toBe(true);
      flow.afterTool('file_read', 'done', 'slice');
      const result = flow.modelResult('slice');
      expect(result.includes('DEVELOPMENT_EXPLORATION_CHECKPOINT')).toBe(index === EXPLORATION_WARNING || index === 10);
    }
    expect(flow.beforeTool('grep', { pattern: 'new query' }, root))
      .toMatchObject({ allowed: false, terminal: true, reason: expect.stringContaining('DEVELOPMENT_EXPLORATION_LIMIT') });
  });

  it('reserves exploration slots before dispatch so concurrent callbacks cannot bypass the limit', () => {
    const root = tempRoot(), flow = new DevelopmentWorkflow(agent, task('Fix the board filter'));
    for (let index = 0; index < EXPLORATION_LIMIT; index++) {
      expect(flow.beforeTool('file_read', { offset: index * 100 }, root).allowed).toBe(true);
    }
    expect(flow.beforeTool('file_read', { offset: 1300 }, root)).toMatchObject({ allowed: false, terminal: true });
    for (let index = 0; index < EXPLORATION_LIMIT; index++) flow.afterTool('file_read', 'done', 'slice');
    expect(flow.beforeTool('file_read', { offset: 1400 }, root).allowed).toBe(false);
  });

  it('preserves pagination fields and returns guidance once, separate from the raw receipt', () => {
    const flow = new DevelopmentWorkflow(agent, task('Fix the board'));
    for (let index = 0; index < EXPLORATION_WARNING; index++) flow.afterTool('file_read', 'done', 'slice');
    const packet = { content: 'original', offset: 100, nextOffset: 200, sha256: 'abc', truncated: true };
    const raw = JSON.stringify(packet);
    expect(JSON.parse(flow.modelResult(raw))).toMatchObject({ ...packet, hostDevelopmentGuidance: expect.stringContaining('6/12') });
    expect(flow.modelResult(raw)).toBe(raw);
    expect(packet).not.toHaveProperty('hostDevelopmentGuidance');
  });

  it.each([
    ['file_write', 'failed', 'Write failed: denied', { content: 'real content' }],
    ['file_write', 'done', 'Written: src/app.ts', { content: '' }],
    ['apply_patch', 'done', 'Patch failed: mismatch', { old_str: 'old', new_str: 'new' }],
    ['apply_patch', 'done', 'Patched src/app.ts', { old_str: 'same', new_str: 'same' }],
    ['shell_exec', 'done', 'All old tests passed', { command: 'npm test' }],
  ] as const)('does not reset exploration for false progress: %s %s %s', (tool, status, output, input) => {
    const flow = new DevelopmentWorkflow(agent, task('Fix the board')), root = tempRoot();
    for (let index = 0; index < EXPLORATION_LIMIT; index++) flow.afterTool('file_read', 'done', 'slice');
    flow.afterTool(tool, status, output, input);
    expect(flow.beforeTool('file_read', {}, root).allowed).toBe(false);
  });

  it.each([
    ['file_write', 'Written: src/app.ts', { content: 'export const task = true;' }],
    ['apply_patch', 'Patched src/app.ts', { old_str: 'old', new_str: 'new' }],
  ] as const)('resets after actual successful %s', (tool, output, input) => {
    const flow = new DevelopmentWorkflow(agent, task('Fix the board')), root = tempRoot();
    for (let index = 0; index < EXPLORATION_LIMIT; index++) flow.afterTool('file_read', 'done', 'slice');
    flow.afterTool(tool, 'done', output, input);
    expect(flow.beforeTool('file_read', {}, root).allowed).toBe(true);
    expect(flow.modelResult('raw')).toBe('raw');
  });

  it('does not force write progress on read-only verification or nondeveloper work', () => {
    const root = tempRoot();
    for (const flow of [new DevelopmentWorkflow(agent, task('Only review the system')),
      new DevelopmentWorkflow({ id: 'qa', role: 'qa' }, task('Review the system'))]) {
      for (let index = 0; index < 20; index++) flow.afterTool('file_read', 'done', 'slice');
      expect(flow.beforeTool('file_read', {}, root).allowed).toBe(true);
      expect(flow.modelResult('raw')).toBe('raw');
      expect(developmentPrompt(flow.profile)).not.toContain('docs/development-plan.json');
      if (flow.profile.kind === 'none') expect(developmentPrompt(flow.profile)).toBe('');
      else expect(developmentPrompt(flow.profile)).toContain('verification protocol');
    }
  });
});
