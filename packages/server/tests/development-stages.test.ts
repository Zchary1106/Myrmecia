import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevelopmentStages } from '../src/agents/development-stages.js';
import { developmentProfile, SYSTEM_DESIGN_PATH } from '../src/agents/development-workflow.js';
import { writeDesignFixtures } from './fixtures/development-design.js';
import { getRuntimeLimits } from '../src/agents/runtime-limits.js';

let root: string;
const taskId = 'task-development';
const profile = developmentProfile({ id: 'dev', role: 'developer' }, {
  id: taskId, input: 'Build a complete application with a frontend UI', description: '',
});
const receipt = (exitCode = 0, stdout = '# tests 3\n# pass 3\n# fail 0\n') => ({
  command: 'npm test', cwd: root, exitCode, stdout, stderr: '', receiptId: 'tr-host',
});
function toVerification() {
  const s = new DevelopmentStages(profile);
  s.finishRequest(root, 100);
  s.finishRequest(root, 200);
  expect(s.finishRequest(root, 300)).toBe('verify');
  return s;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'myrmecia-stages-')); writeDesignFixtures(root);
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test test/*.test.mjs"}}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('host-owned development stages', () => {
  it('requires real design/source gates and does not treat a model final as delivery', () => {
    const s = new DevelopmentStages(profile);
    expect(s.state.phase).toBe('design');
    expect(s.finishRequest(root, 50)).toBe('next');
    expect(s.state.phase).toBe('core');
    rmSync(join(root, 'src/store.ts'));
    expect(() => s.finishRequest(root, 100)).toThrow('STAGE_INCOMPLETE');
    expect(s.state.phase).toBe('core');
  });
  it('gates a system-only task without imposing a UI stage', () => {
    const s = new DevelopmentStages({ ...profile, kind: 'system', designPaths: [SYSTEM_DESIGN_PATH] });
    s.finishRequest(root, 50);
    expect(s.state.phase).toBe('implementation');
    expect(s.finishRequest(root, 100)).toBe('verify');
  });
  it('takes one real failed receipt into one repair and stops after a second failure', () => {
    const s = toVerification();
    s.verified(receipt(1, 'AssertionError: PATCH partial update rejected'), root, 300);
    expect(s.state).toMatchObject({ phase: 'repair', repairAttempts: 1 });
    expect(JSON.stringify(s.messages('policy', 'request'))).toContain('PATCH partial update rejected');
    expect(s.finishRequest(root, 400)).toBe('verify');
    expect(() => s.verified(receipt(1), root, 400)).toThrow('VERIFICATION_FAILED');
    expect(s.state.repairAttempts).toBe(1);
  });
  it('freezes failing tests/config and forbids repairing by changing tests or arbitrary shell', () => {
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test/crud.test.mjs'), 'real assertion');
    writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test test/*.test.mjs"}}');
    const s = toVerification();
    s.verified(receipt(1), root, 300);
    expect(s.beforeTool('file_write', { path: 'src/store.ts' }, root).allowed).toBe(true);
    expect(s.beforeTool('file_write', { path: 'test/crud.test.mjs' }, root).allowed).toBe(false);
    expect(s.beforeTool('shell_exec', { command: 'npm test' }, root).allowed).toBe(false);
    writeFileSync(join(root, 'test/crud.test.mjs'), 'trivial passing test');
    expect(() => s.finishRequest(root, 400)).toThrow('TEST_INPUT_CHANGED');
  });
  it.each(['scripts/check.mjs', 'tools/verify.mjs'])('protects a pinned custom Node test entry even if design declares it implementation: %s', path => {
    mkdirSync(join(root, path.split('/')[0]));
    writeFileSync(join(root, path), 'real failing test assertions');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: `node ${path}` } }));
    const designPath = join(root, SYSTEM_DESIGN_PATH);
    const design = JSON.parse(readFileSync(designPath, 'utf8'));
    design.modules[1].sourceFiles.push(path);
    writeFileSync(designPath, JSON.stringify(design));
    const s = toVerification();
    s.verified(receipt(1), root, 300);
    expect(s.beforeTool('file_write', { path }, root).allowed).toBe(false);
    writeFileSync(join(root, path), 'trivial pass');
    expect(() => s.finishRequest(root, 400)).toThrow('TEST_INPUT_CHANGED');
  });
  it('requires reconciliation instead of repair when a complex runner entry is unknown', () => {
    writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"vitest run --config tools/check.ts"}}');
    const s = toVerification();
    expect(() => s.verified(receipt(1), root, 300)).toThrow('REPAIR_RECONCILIATION');
    expect(s.state.repairAttempts).toBe(0);
  });
  it.each(['test-check.mjs', 'check-test.mjs'])('does not grant repair over default Node discovery source declarations: %s', path => {
    writeFileSync(join(root, path), 'real failing default-discovered test');
    writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
    const designPath = join(root, SYSTEM_DESIGN_PATH);
    const design = JSON.parse(readFileSync(designPath, 'utf8'));
    design.modules[1].sourceFiles.push(path);
    writeFileSync(designPath, JSON.stringify(design));
    const s = toVerification();
    expect(() => s.verified(receipt(1), root, 300)).toThrow('REPAIR_RECONCILIATION');
    expect(s.state).toMatchObject({ phase: 'verification', repairAttempts: 0 });
  });
  it.each(['# tests 0\n', 'No actual receipt summary', '# tests 3\n# skipped 3\n'])('rejects zero/unobserved/skipped tests without repairing: %s', stdout => {
    const s = toVerification();
    expect(() => s.verified(receipt(0, stdout), root, 300)).toThrow('VERIFICATION_FAILED');
    expect(s.state.repairAttempts).toBe(0);
  });
  it('freezes design and enforces delivery readonly and unchanged evidence', () => {
    const s = toVerification();
    s.verified(receipt(), root, 300);
    expect(s.state).toMatchObject({ phase: 'delivery', browserAcceptance: 'unverified' });
    expect(s.beforeTool('file_write', { path: 'src/app.ts' }, root).allowed).toBe(false);
    expect(s.beforeTool('shell_exec', { command: 'npm test' }, root).allowed).toBe(false);
    writeFileSync(join(root, 'src/app.ts'), 'export const changed = true;');
    expect(() => s.finishRequest(root, 400)).toThrow('EVIDENCE_CHANGED');
    const another = new DevelopmentStages(profile);
    another.finishRequest(root, 20);
    const path = join(root, SYSTEM_DESIGN_PATH);
    writeFileSync(path, readFileSync(path, 'utf8').replace('integrated task board', 'different task board'));
    expect(() => another.finishRequest(root, 30)).toThrow('DESIGN_CHANGED');
  });
  it('refuses a verifier that changed the files it was checking', () => {
    const s = toVerification();
    writeFileSync(join(root, 'src/store.ts'), 'export const bypass = true;');
    expect(() => s.verified(receipt(), root, 300)).toThrow('VERIFIER_MUTATED_SOURCE');
  });
  it('isolates design effects without imposing new tool permissions', () => {
    const s = new DevelopmentStages(profile);
    expect(s.beforeTool('file_read', { path: 'README.md' }, root).allowed).toBe(true);
    expect(s.beforeTool('file_write', { file_path: SYSTEM_DESIGN_PATH }, root).allowed).toBe(true);
    for (const tool of ['file_write', 'shell_exec', 'mcp-unknown']) {
      expect(s.beforeTool(tool, { path: 'src/app.ts' }, root).allowed).toBe(false);
    }
    s.finishRequest(root, 100);
    expect(s.beforeTool('apply_patch', { path: SYSTEM_DESIGN_PATH }, root).allowed).toBe(false);
  });
  it('retains real instructions separately from model summaries and invalidates late steering', () => {
    const s = new DevelopmentStages(profile);
    s.retainInstructions(['Do not add external dependencies']);
    s.finishRequest(root, 100);
    const next = s.messages('policy', 'original');
    expect(JSON.stringify(next)).toContain('Do not add external dependencies');
    expect(next.filter(m => m.role === 'user')).toHaveLength(2);
    s.finishRequest(root, 200);
    s.finishRequest(root, 300);
    s.verified(receipt(), root, 300);
    expect(() => s.retainInstructions(['Also add auth'])).toThrow('STEER_AFTER_VERIFICATION');
  });
  it('persists revision/repair and allocations without resetting lifetime usage', () => {
    const s = toVerification();
    s.verified(receipt(1), root, 300);
    const resumed = new DevelopmentStages(profile, s.state);
    expect(resumed.state).toMatchObject({ phase: 'repair', repairAttempts: 1, startedTokens: 300, revision: 4 });
    const limits = getRuntimeLimits();
    expect(resumed.limits(limits).maxExecutionTokens).toBeLessThanOrEqual(limits.maxExecutionTokens);
    expect(resumed.limits(limits).maxExecutionTokens).toBe(300 + Math.floor(limits.maxExecutionTokens * .25));
    expect(() => new DevelopmentStages(profile, { ...s.state, phase: 'verification' })).toThrow('RECONCILIATION');
  });
});
