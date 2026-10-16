import { resolve, join } from 'node:path';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { DevelopmentStageState } from '@myrmecia/shared';
import { testExecutionStatus } from '@myrmecia/shared';
import { BUILTIN_TOOLS } from '../tools/tool-registry.js';
import type { RuntimeLimits } from './runtime-limits.js';
import { AgentRunStopped } from './run-state.js';
import {
  checkDevelopmentArtifacts, SYSTEM_DESIGN_PATH, UI_DESIGN_PATH, type DevelopmentProfile,
} from './development-workflow.js';
import type { TestExecutionEvidence } from '../testing/test-report.js';

type Messages = OpenAI.Chat.Completions.ChatCompletionMessageParam[];
type Artifact = { path: string; sha256: string };
const readOnly = (tool: string) => BUILTIN_TOOLS.some(item => item.id === tool && item.metadata?.readOnly === true);
const sameArtifacts = (a: Artifact[], b: Artifact[]) => JSON.stringify([...a].sort((x, y) => x.path.localeCompare(y.path)))
  === JSON.stringify([...b].sort((x, y) => x.path.localeCompare(y.path)));
const testFile = (path: string) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(path);
function testEntrypoints(workdir: string): { patterns: string[]; supported: boolean } {
  try {
    const script: unknown = JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf8')).scripts?.test;
    if (typeof script !== 'string') return { patterns: [], supported: false };
    const parts = script.trim().split(/\s+/);
    if (parts.shift() !== 'node') return { patterns: [], supported: false };
    const discovery = parts[0] === '--test';
    if (discovery) parts.shift();
    // Default discovery has Node-version-specific filenames. Require an
    // explicit entry instead of trusting model-declared implementation paths.
    if (discovery && parts.length === 0) return { patterns: [], supported: false };
    if (!discovery && parts.length !== 1 || parts.some(path =>
      !/^[\w./*?-]+$/.test(path) || path.startsWith('-') || path.startsWith('/') || path.split('/').includes('..'))) {
      return { patterns: [], supported: false };
    }
    return { patterns: parts.map(path => path.replace(/^\.\//, '')), supported: true };
  } catch { return { patterns: [], supported: false }; }
}
function protectedTest(path: string, patterns: string[]): boolean {
  return testFile(path) || patterns.some(pattern => {
    // Simple Node entry/glob grammar only. Unknown runners cannot enable inline repair.
    const regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regex}(?:/.*)?$`).test(path);
  });
}

/** Freeze bounded non-implementation inputs before the first verifier. */
function verificationInputs(workdir: string, sourceFiles: string[], patterns: string[]): Artifact[] {
  const root = realpathSync(workdir), result: Artifact[] = [];
  let count = 0, bytes = 0;
  const visit = (dir: string) => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = dir ? `${dir}/${name}` : name;
      const stat = lstatSync(join(root, path));
      if (++count > 1000 || stat.isSymbolicLink()) throw new Error('DEVELOPMENT_TEST_INPUT_UNSAFE: unsafe/oversized test input tree');
      if (stat.isDirectory()) { visit(path); continue; }
      if (!stat.isFile() || sourceFiles.includes(path) && !protectedTest(path, patterns)) continue;
      bytes += stat.size;
      if (stat.size > 1_000_000 || bytes > 5_000_000) throw new Error('DEVELOPMENT_TEST_INPUT_UNSAFE: test input quota exceeded');
      result.push({ path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') });
    }
  };
  visit('');
  return result;
}

/** One execution, one task budget and deadline. Never recursively execute a new task per stage. */
export class DevelopmentStages {
  readonly state: DevelopmentStageState;
  private refusals = 0;
  constructor(readonly profile: DevelopmentProfile, snapshot?: DevelopmentStageState) {
    this.state = snapshot ? structuredClone(snapshot) : {
      schemaVersion: 1, revision: 0, phase: 'design', startedTokens: 0, repairAttempts: 0,
      instructions: [], designArtifacts: [], verifiedArtifacts: [], history: [], browserAcceptance: 'unverified',
    };
    if (this.state.phase === 'verification' || this.state.phase === 'complete') {
      throw new AgentRunStopped('interrupted', 'DEVELOPMENT_STAGE_RECONCILIATION: cannot replay a pending verifier or completed run');
    }
  }
  static enabled(profile: DevelopmentProfile): boolean {
    return profile.kind === 'system' || profile.kind === 'ui';
  }
  /** Each provider-owned loop gets only its phase allocation, never a fresh lifetime allowance. */
  limits(limits: RuntimeLimits): RuntimeLimits {
    const weights = { design: .25, core: .4, ui: .4, implementation: .6, repair: .25, delivery: .08 };
    const weight = weights[this.state.phase as keyof typeof weights] ?? 0;
    return { ...limits, maxExecutionTokens: Math.min(limits.maxExecutionTokens,
      this.state.startedTokens + Math.floor(limits.maxExecutionTokens * weight)) };
  }
  beforeTool(tool: string, input: Record<string, unknown>, workdir: string): { allowed: boolean; reason?: string; terminal?: boolean } {
    if (readOnly(tool)) return { allowed: true };
    const raw = input.path ?? input.file_path;
    const isDesign = typeof raw === 'string' && this.profile.designPaths.some(path => resolve(workdir, raw) === resolve(workdir, path));
    const write = tool === 'file_write' || tool === 'apply_patch';
    if (this.state.phase === 'design') {
      if (write && isDesign) return { allowed: true };
      return this.refuse('design request may only read and write its declared design JSON. Return a brief handoff; the host starts implementation separately.');
    }
    if (this.state.phase === 'delivery' || this.state.phase === 'verification') {
      return this.refuse('verification/delivery cannot mutate files or execute effects. Tests are owned by the pinned host verifier.');
    }
    if (this.state.phase === 'repair') {
      const paths = this.state.verifiedArtifacts.filter(item => !this.profile.designPaths.includes(item.path)
        && !protectedTest(item.path, this.state.testEntryPatterns || []));
      if (!write || typeof raw !== 'string' || !paths.some(item => resolve(workdir, raw) === resolve(workdir, item.path))) {
        return this.refuse('repair may only patch declared implementation sources. Test/config/support inputs are frozen; shell and other effects are unavailable. Changing tests requires explicit reconciliation.');
      }
    }
    if (write && isDesign) return this.refuse('approved stage design is frozen; do not remove deliverables to make a gate pass.');
    return { allowed: true };
  }
  private refuse(reason: string) {
    return { allowed: false, reason: `DEVELOPMENT_STAGE_SCOPE: ${reason}`, terminal: ++this.refusals >= 3 };
  }
  retainInstructions(contents: string[]): void {
    for (const content of contents) {
      if (content && !this.state.instructions.includes(content)) {
        if (this.state.phase === 'delivery') throw new AgentRunStopped('interrupted',
          'DEVELOPMENT_STEER_AFTER_VERIFICATION: new instructions require a newly scoped verification, not delivery under an old receipt');
        this.state.instructions.push(content);
      }
    }
    // Never silently lose a steer instruction during a context reset.
    if (this.state.instructions.join('\n').length > 32_000) {
      throw new AgentRunStopped('token_budget', 'DEVELOPMENT_INSTRUCTION_LIMIT: retained instructions require explicit reconciliation');
    }
  }
  messages(system: string, original: string): Messages {
    const phase = this.state.phase;
    const instruction = {
      design: 'Read only relevant spec/entry files. Write the task-bound system/UI design JSON. Do NOT implement code or run commands in this request. Then return a concise design handoff and STOP; the host will start a separate implementation request.',
      core: 'Implement the non-UI modules, real data persistence/API/error behavior and regression tests from the frozen design. Do not spend this request polishing the UI. Stop once declared non-UI source files exist; the host starts the UI request next.',
      ui: 'Implement and integrate every declared UI source file using the frozen UI design and real core interfaces. Complete keyboard interactions, loading/empty/error states and mobile layout. Do not claim browser acceptance. Then STOP; the host runs the pinned tests.',
      implementation: 'Implement all declared system source files and real regression tests using the frozen design and approved spec. Then STOP; the host runs the pinned tests.',
      verification: 'The host owns verification; no model request is permitted.',
      repair: 'Repair ONLY the defects demonstrated by the host verifier below. Read exact affected blocks, then file_write/apply_patch declared implementation sources only. Shell and non-read effects are disabled; tests/config/support inputs are frozen. Preserve the approved spec/design and user work. Changing tests requires operator reconciliation. This is the only repair attempt. Then STOP for the host retest.',
      delivery: 'Do not modify files or run commands. Report what was built, concrete entry paths, the real host test receipt/result below, and remaining risks. Browser/visual acceptance is NOT verified by this runtime. Do not claim independent acceptance or production readiness.',
      complete: 'No further requests.',
    }[phase];
    return [
      { role: 'system', content: `${system}\n\n## Host-owned development stage v1: ${phase}\n${instruction}\nEach stage is a separate bounded request in the SAME task/execution. Never restart the task, change model or increase limits. Read-before-write still applies. Stage handoff is not final task acceptance.` },
      { role: 'user', content: original },
      ...this.state.instructions.map(content => ({ role: 'user' as const, content })),
      { role: 'system', content: `Host evidence (schema/file checks are NOT behavior/visual acceptance):\n${JSON.stringify({
        designArtifacts: this.state.designArtifacts, receiptId: this.state.receiptId,
        history: this.state.history, feedback: this.state.feedback,
        browserAcceptance: 'unverified',
      })}` },
    ];
  }
  private move(phase: DevelopmentStageState['phase'], tokens: number): void {
    this.state.phase = phase;
    this.state.revision++;
    this.refusals = 0;
    this.state.startedTokens = tokens;
  }
  private check(workdir: string, sources: boolean, exclude: string[] = []) {
    const check = checkDevelopmentArtifacts(this.profile, workdir, sources, exclude);
    if (!check.valid) throw new AgentRunStopped('failed', `DEVELOPMENT_STAGE_INCOMPLETE: ${check.errors.join('; ')}`);
    const designs = check.verified.filter(item => this.profile.designPaths.includes(item.path));
    if (this.state.designArtifacts.length && !sameArtifacts(designs, this.state.designArtifacts)) {
      throw new AgentRunStopped('failed', 'DEVELOPMENT_DESIGN_CHANGED: frozen design changed after handoff');
    }
    return check;
  }
  private checkInputs(workdir: string, sourceFiles: string[]) {
    if (!this.state.testEntryPatterns) {
      const entries = testEntrypoints(workdir);
      this.state.testEntryPatterns = entries.patterns;
      this.state.repairSupported = entries.supported;
    }
    const current = verificationInputs(workdir, sourceFiles, this.state.testEntryPatterns);
    if (this.state.verificationInputs && !sameArtifacts(current, this.state.verificationInputs)) {
      throw new AgentRunStopped('failed', 'DEVELOPMENT_TEST_INPUT_CHANGED: tests/config/support changed after initial verification; fresh operator reconciliation required');
    }
    this.state.verificationInputs ??= current;
  }
  /** Called only after a provider final response. Model text itself cannot advance a gate. */
  finishRequest(workdir: string, tokens: number): 'next' | 'verify' | 'complete' {
    const phase = this.state.phase;
    if (phase === 'design') {
      this.state.designArtifacts = this.check(workdir, false).verified;
      this.state.history.push({ phase, status: 'passed', summary: 'Task-bound design schema checked; design quality remains unaccepted' });
      this.move(this.profile.designPaths.includes(UI_DESIGN_PATH)
        ? this.profile.designPaths.includes(SYSTEM_DESIGN_PATH) ? 'core' : 'ui' : 'implementation', tokens);
      return 'next';
    }
    if (phase === 'core') {
      const ui = checkDevelopmentArtifacts({ ...this.profile, designPaths: [UI_DESIGN_PATH] }, workdir);
      this.check(workdir, true, ui.sourceFiles);
      this.state.history.push({ phase, status: 'passed', summary: 'Declared non-UI source files exist; behavior not yet verified' });
      this.move('ui', tokens);
      return 'next';
    }
    if (phase === 'delivery') {
      const checked = this.check(workdir, true);
      this.checkInputs(workdir, checked.sourceFiles);
      if (!this.state.receiptId || !sameArtifacts(checked.verified, this.state.verifiedArtifacts)) {
        throw new AgentRunStopped('failed', 'DEVELOPMENT_EVIDENCE_CHANGED: files changed after host verification');
      }
      this.move('complete', tokens);
      return 'complete';
    }
    const checked = this.check(workdir, true);
    this.checkInputs(workdir, checked.sourceFiles);
    this.state.verifiedArtifacts = checked.verified;
    this.move('verification', tokens);
    return 'verify';
  }
  verified(result: TestExecutionEvidence & { receiptId: string }, workdir: string, tokens: number): void {
    const checked = this.check(workdir, true);
    this.checkInputs(workdir, checked.sourceFiles);
    if (!sameArtifacts(checked.verified, this.state.verifiedArtifacts)) {
      throw new AgentRunStopped('failed', 'DEVELOPMENT_VERIFIER_MUTATED_SOURCE: declared files changed during verification');
    }
    const status = testExecutionStatus(result);
    this.state.receiptId = result.receiptId;
    this.state.feedback = `Host receipt ${result.receiptId}; ${result.command}; exit ${result.exitCode}; ${status}\n${result.stdout}\n${result.stderr}`.slice(-14_000);
    this.state.history.push({ phase: 'verification', status: status === 'passed' ? 'passed' : 'failed',
      summary: `Host ${result.command}: ${status}; receipt ${result.receiptId}` });
    if (status === 'passed') {
      this.move('delivery', tokens);
    } else if (status === 'failed' && this.state.repairAttempts === 0) {
      if (!this.state.repairSupported) throw new AgentRunStopped('failed',
        'DEVELOPMENT_REPAIR_RECONCILIATION: test entrypoints could not be bounded from the pinned script; explicit operator scope required');
      this.state.repairAttempts = 1;
      this.move('repair', tokens);
    } else {
      throw new AgentRunStopped('failed', `DEVELOPMENT_VERIFICATION_FAILED: ${status}; bounded repair exhausted or test evidence unavailable; receipt ${result.receiptId}`);
    }
  }
}
