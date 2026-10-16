import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { CompletionCriterion, CompletionCriterionResult, CompletionVerification, Task } from '../types.js';
import { getTask } from '../db/models/task.js';
import { getExecutionArtifact, listExecutionArtifacts, upsertExecutionArtifact, type StoredExecutionArtifact } from '../db/models/execution-artifact.js';
import { executeTool } from '../skills/tool-sandbox.js';
import { dlpCheck } from '../security/dlp.js';
import { runWriteOnce } from '../tools/write-once.js';
import { runtimeV2Enabled } from './runtime-version.js';
import { markBudgetDispatched, reserveBudget, settleUsage } from './budget-service.js';
import { getExecution } from '../db/models/execution.js';
import { boundedJsonSchema, outputMatchesSchema, MAX_EVALUATION_OUTPUT_BYTES } from './completion-json-schema.js';
import { readArtifactSnapshot, saveArtifactSnapshot } from '../artifacts/artifact-snapshot-store.js';
import { parseVerificationCommand } from '@myrmecia/shared';
import { testExecutionStatus } from '@myrmecia/shared';

const base = { id: z.string().regex(/^[a-zA-Z0-9._:-]{1,80}$/), label: z.string().min(1).max(200), required: z.boolean() };
export const completionCriteriaSchema = z.array(z.discriminatedUnion('verifier', [
  z.object({ ...base, verifier: z.literal('artifact'), relativePath: z.string().min(1).max(500)
    .refine(value => !isAbsolute(value) && !value.split(/[\\/]/).includes('..'), 'Artifact path must be relative and contained'),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ ...base, verifier: z.literal('output_contains'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ ...base, verifier: z.literal('output_not_contains'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ ...base, verifier: z.literal('output_json_schema'), schema: z.record(z.unknown()).refine(boundedJsonSchema, 'Unsupported or unbounded JSON schema') }).strict(),
  z.object({ ...base, verifier: z.literal('human_review'), rubric: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ ...base, verifier: z.literal('test_command'), command: z.string().max(500).refine(value => !!parseVerificationCommand(value), 'Unsupported validation command; use bounded test/build/lint/typecheck commands without shell source'),
    timeoutMs: z.number().int().min(1).max(120_000).optional() }).strict(),
  z.object({ ...base, verifier: z.literal('external'), verifierId: z.string().min(1).max(100) }).strict(),
])).max(20).refine(values => new Set(values.map(item => item.id)).size === values.length, 'Criterion IDs must be unique');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function artifactBytes(task: Task, artifact: StoredExecutionArtifact): Buffer {
  if (artifact.workspaceId !== (task.workspaceId || 'default') || artifact.taskId !== task.id) throw new Error('ARTIFACT_SCOPE_DENIED');
  const snapshot = readArtifactSnapshot(artifact);
  if (snapshot) return snapshot;
  if (artifact.metadata?.immutable || artifact.metadata?.captureState === 'pending') throw new Error('ARTIFACT_SNAPSHOT_UNAVAILABLE');
  if (artifact.source !== 'workspace') {
    if (artifact.content === undefined) throw new Error('ARTIFACT_CONTENT_UNAVAILABLE');
    return Buffer.from(artifact.content);
  }
  const root = realpathSync(task.workdir || task.workspacePath || '');
  if (!root || root === '/' || root === process.env.HOME) throw new Error('ARTIFACT_WORKSPACE_UNAVAILABLE');
  const target = realpathSync(resolve(root, artifact.relativePath));
  const path = relative(root, target);
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error('ARTIFACT_SCOPE_DENIED');
  const info = statSync(target);
  if (!info.isFile() || info.size > 20_000_000) throw new Error('ARTIFACT_CONTENT_UNAVAILABLE');
  return readFileSync(target);
}

export function completionEvidenceIsFresh(task: Task, executionId: string, verification: CompletionVerification): boolean {
  try {
    for (const item of verification.criteria.filter(item => item.required && item.status === 'passed')) {
      for (const evidence of item.evidence) {
        if (evidence.ref.startsWith('artifact://')) {
          const artifact = getExecutionArtifact(evidence.ref.slice(11));
          if (!artifact || artifact.executionId !== executionId || sha(artifactBytes(task, artifact)) !== evidence.sha256) return false;
        } else if (evidence.ref === `execution://${executionId}/output` && sha(task.output || '') !== evidence.sha256) return false;
        else if (evidence.ref !== `execution://${executionId}/output`) return false;
      }
      if (!item.evidence.length) return false;
    }
    return true;
  } catch { return false; }
}

/** Criterion authority is read from the persisted submission, not an executor's completion JSON. */
export async function verifyCompletionCriteria(task: Task, executionId: string, output: string, signal?: AbortSignal): Promise<CompletionVerification> {
  const persisted = getTask(task.id);
  if (!persisted || (persisted.workspaceId || 'default') !== (task.workspaceId || 'default')) throw new Error('COMPLETION_CONTRACT_SCOPE_DENIED');
  const criteria = completionCriteriaSchema.parse(persisted.completionCriteria || []) as CompletionCriterion[];
  const results: CompletionCriterionResult[] = [];
  for (const criterion of criteria) {
    const common = { criterionId: criterion.id, required: criterion.required, verifier: criterion.verifier };
    if (signal?.aborted) {
      results.push({ ...common, scope: 'external', status: 'unavailable', message: 'Verification cancelled', evidence: [] });
      continue;
    }
    try {
      if (criterion.verifier === 'artifact') {
        const artifact = listExecutionArtifacts({ workspaceId: task.workspaceId || 'default', taskId: task.id, executionId, limit: 1000 })
          .find(item => item.relativePath === criterion.relativePath);
        if (!artifact) {
          results.push({ ...common, scope: 'artifact', status: 'failed', message: 'Required artifact was not indexed in this execution', evidence: [] });
          continue;
        }
        const body = artifactBytes(persisted, artifact);
        const actual = sha(body);
        const recorded = typeof artifact.metadata.sha256 === 'string' ? artifact.metadata.sha256 : undefined;
        const passed = (!criterion.expectedSha256 || criterion.expectedSha256 === actual) && (!recorded || recorded === actual);
        results.push({ ...common, scope: 'artifact', status: passed ? 'passed' : 'failed',
          message: passed ? 'Artifact bytes verified in the submitted scope' : 'Artifact hash mismatch',
          evidence: [{ ref: `artifact://${artifact.id}`, sha256: actual }] });
      } else if (criterion.verifier === 'output_contains' || criterion.verifier === 'output_not_contains' || criterion.verifier === 'output_json_schema') {
        const passed = output.trim().length > 0 && Buffer.byteLength(output) <= MAX_EVALUATION_OUTPUT_BYTES
          && (criterion.verifier === 'output_json_schema' ? outputMatchesSchema(output, criterion.schema)
            : criterion.verifier === 'output_contains' ? output.includes(criterion.text) : !output.includes(criterion.text));
        results.push({ ...common, scope: 'output', status: passed ? 'passed' : 'failed',
          message: 'Literal output assertion only; not proof of external task success',
          evidence: [{ ref: `execution://${executionId}/output`, sha256: sha(output) }] });
      } else if (criterion.verifier === 'test_command') {
        const command = parseVerificationCommand(criterion.command);
        if (!command) throw new Error('VERIFICATION_COMMAND_DENIED');
        const root = persisted.workdir || persisted.workspacePath;
        if (!root || root === '/' || root === process.env.HOME) throw new Error('Submitted verifier workspace unavailable');
        const timeoutMs = criterion.timeoutMs || 60_000;
        const budgetKey = `verifier:${executionId}:${criterion.id}`;
        const workspaceId = task.workspaceId || 'default';
        if (runtimeV2Enabled()) {
          reserveBudget({ workspaceId, taskId: task.id, agentId: getExecution(executionId)?.agentDefId || 'verifier',
            key: budgetKey, kind: 'tool', tokens: 0, toolCalls: 1, runtimeMs: timeoutMs, costType: 'exact', costUSD: 0 });
          markBudgetDispatched(workspaceId, budgetKey);
        }
        const startedAt = Date.now();
        const result = await runWriteOnce(persisted, executionId, 'shell_exec', { command: command.shellCommand, criterionId: criterion.id },
          () => executeTool('shell_exec', { command: command.shellCommand }, root,
            { signal, timeoutMs, maxOutputChars: 8000, allowedTools: ['shell_exec'] }), signal);
        if (runtimeV2Enabled()) settleUsage({ workspaceId, key: budgetKey, eventKey: `${budgetKey}:receipt`, mode: 'cumulative',
          tokens: 0, runtimeMs: Date.now() - startedAt, costType: 'exact', costUSD: 0 });
        const checked = dlpCheck(result.output, { taskId: task.id, workspaceId: task.workspaceId });
        const body = checked.redactedContent || result.output;
        const blocked = checked.violations.some(item => item.action === 'block');
        const validationStatus = result.status === 'done'
          ? testExecutionStatus({ command: criterion.command, exitCode: 0, stdout: body }) : 'failed';
        const artifact = blocked ? undefined : upsertExecutionArtifact({
          workspaceId: task.workspaceId || 'default', taskId: task.id, executionId,
          name: `Verifier ${criterion.id}`, kind: 'text', mimeType: 'text/plain', source: 'output',
          relativePath: `.verification/${criterion.id}.txt`, content: body, sizeBytes: Buffer.byteLength(body),
          metadata: { criterionId: criterion.id, command: criterion.command, sha256: sha(body) },
        });
        if (artifact) saveArtifactSnapshot(artifact, Buffer.from(body));
        const evidence = artifact ? [{ ref: `artifact://${artifact.id}`, sha256: sha(body) }] : [];
        results.push({ ...common, scope: 'workspace',
          status: blocked || validationStatus === 'unknown' || validationStatus === 'skipped'
            || result.status !== 'done' && /UNAVAILABLE|UNSUPPORTED|disabled|timed out|TIMEOUT|not found|aborted/i.test(result.output)
            ? 'unavailable' : validationStatus,
          message: validationStatus === 'passed' ? 'Submitted bounded validation command executed successfully'
            : validationStatus === 'unknown' || validationStatus === 'skipped'
              ? 'Test command exited without verifiable executed cases' : 'Submitted test command failed or could not be enforced',
          evidence });
      } else if (criterion.verifier === 'human_review') {
        results.push({ ...common, scope: 'external', status: 'unavailable',
          message: 'Human review required; a natural-language rubric is not an automatic pass', evidence: [] });
      } else {
        results.push({ ...common, scope: 'external', status: 'unavailable', message: `Verifier ${criterion.verifierId} is not registered`, evidence: [] });
      }
    } catch (error) {
      results.push({ ...common, scope: criterion.verifier === 'artifact' ? 'artifact' : 'workspace',
        status: criterion.verifier === 'artifact' && ((error as NodeJS.ErrnoException).code === 'ENOENT'
          || (error as Error).message === 'ARTIFACT_SCOPE_DENIED') ? 'failed' : 'unavailable',
        message: 'Verifier could not inspect its authorized evidence', evidence: [] });
    }
  }
  const mandatory = results.filter(item => item.required);
  return { schemaVersion: 1, status: !criteria.length ? 'not_requested'
    : mandatory.some(item => item.status === 'failed') ? 'failed'
      : mandatory.some(item => item.status === 'unavailable') ? 'unavailable' : 'passed',
    contractSha256: sha(JSON.stringify(criteria)), checkedAt: new Date().toISOString(), criteria: results };
}
