import { randomUUID } from 'node:crypto';
import type { AgentSetupDraft, AgentSetupForm } from '../../types.js';
import { getDb } from '../database.js';
import { HttpError } from '../../routes/http.js';
import { getSkillAssignmentForAgent } from './skill.js';
import { agentSetupPayload } from '@myrmecia/shared';
import { createHash } from 'node:crypto';

const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, canonical(item)])) : value;
export function validateDraftRequest(owner: DraftOwner, key: string | undefined, operation: 'create' | 'test', payload: unknown): void {
  if (!key) return;
  const row = getDb().get<any>(
    `SELECT * FROM agent_setup_drafts WHERE workspace_id = ? AND actor_id = ? AND ${operation === 'create' ? 'creation_key' : 'test_key'} = ?`,
    owner.workspaceId, owner.actorId, key);
  if (!row) return; // Preserve callers that do not use the setup wizard.
  const draft = fromRow(row);
  if (!draft.locked || operation === 'test' && !draft.testSubmitted) throw new HttpError(409, 'DRAFT_NOT_LOCKED', '请先锁定并保存原请求');
  const expected = operation === 'create' ? agentSetupPayload(draft.form) : { prompt: draft.form.testPrompt.trim() };
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  if (hash(payload) !== hash(expected)) throw new HttpError(409, 'DRAFT_PAYLOAD_CONFLICT', '提交内容与已保存的原请求不一致');
}

export interface DraftOwner { workspaceId: string; actorId: string }

function raw(id: string, owner: DraftOwner): any {
  return getDb().get('SELECT * FROM agent_setup_drafts WHERE id = ? AND workspace_id = ? AND actor_id = ?',
    id, owner.workspaceId, owner.actorId);
}
function fromRow(row: any): AgentSetupDraft {
  const db = getDb();
  const form = JSON.parse(row.form) as AgentSetupForm;
  const receipt = (operation: string, key: string) => db.get<{ entity_id: string }>(
    'SELECT entity_id FROM agent_setup_requests WHERE workspace_id = ? AND actor_id = ? AND operation = ? AND request_key = ?',
    row.workspace_id, row.actor_id, operation, key)?.entity_id;
  const agentId = receipt('create', row.creation_key);
  const taskId = agentId ? receipt(`test:${agentId}`, row.test_key) : undefined;
  const bound = !!agentId && (!form.skillVersionId
    || getSkillAssignmentForAgent(agentId)?.skillVersionId === form.skillVersionId);
  return { schemaVersion: 1, id: row.id, workspaceId: row.workspace_id, actorId: row.actor_id,
    revision: row.revision, form, step: row.step, locked: !!row.locked,
    testSubmitted: !!row.test_submitted, creationKey: row.creation_key, testKey: row.test_key,
    agentId, taskId, bound,
    stage: taskId ? 'dispatched' : agentId ? bound ? row.test_submitted ? 'testing' : 'saved' : 'binding'
      : row.locked ? 'creating' : 'draft',
    createdAt: row.created_at, updatedAt: row.updated_at };
}
export function getSetupDraft(id: string, owner: DraftOwner): AgentSetupDraft | undefined {
  const row = raw(id, owner);
  return row ? fromRow(row) : undefined;
}
export function listSetupDrafts(owner: DraftOwner): AgentSetupDraft[] {
  return getDb().all('SELECT * FROM agent_setup_drafts WHERE workspace_id = ? AND actor_id = ? ORDER BY updated_at DESC, id',
    owner.workspaceId, owner.actorId).map(fromRow);
}
export function saveSetupDraft(id: string, owner: DraftOwner, input: {
  expectedRevision: number; form: AgentSetupForm; step: number; locked: boolean; testSubmitted: boolean;
}): AgentSetupDraft {
  const db = getDb();
  return db.transaction(() => {
    const row = raw(id, owner);
    if (!row) {
      // A guessed cross-owner draft ID is never converted into a new draft.
      if (db.get('SELECT id FROM agent_setup_drafts WHERE id = ?', id)
        || input.expectedRevision !== 0) throw new HttpError(404, 'DRAFT_NOT_FOUND', '草稿不存在或无权访问');
      if (input.locked || input.testSubmitted) throw new HttpError(400, 'DRAFT_INVALID_STATE', '先保存草稿再提交');
      db.run(`INSERT INTO agent_setup_drafts(id, workspace_id, actor_id, form, step, creation_key, test_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, id, owner.workspaceId, owner.actorId, JSON.stringify(input.form),
        input.step, randomUUID(), randomUUID());
    } else {
      // Safe replay of a response-lost save, but never accept a different stale edit.
      const same = JSON.stringify(JSON.parse(row.form)) === JSON.stringify(input.form)
        && row.step === input.step && !!row.locked === input.locked && !!row.test_submitted === input.testSubmitted;
      if (row.revision !== input.expectedRevision) {
        if (same && (input.expectedRevision === row.revision - 1 || input.expectedRevision === 0 && row.revision === 1)) return fromRow(row);
        throw new HttpError(409, 'DRAFT_REVISION_CONFLICT', '草稿已在其他窗口更新，请重新加载后继续');
      }
      if (row.locked) {
        const previous = JSON.parse(row.form);
        const withoutPrompt = (form: AgentSetupForm) => ({ ...form, testPrompt: '' });
        if (!input.locked || JSON.stringify(withoutPrompt(previous)) !== JSON.stringify(withoutPrompt(input.form))
          || row.test_submitted && previous.testPrompt !== input.form.testPrompt
          || row.test_submitted && !input.testSubmitted) {
          throw new HttpError(409, 'DRAFT_CONFIGURATION_LOCKED', '原请求已锁定，请继续原流程或创建新草稿');
        }
      }
      if (input.testSubmitted && !input.locked) throw new HttpError(400, 'DRAFT_INVALID_STATE', '测试需要已锁定配置');
      db.run(`UPDATE agent_setup_drafts SET form = ?, step = ?, locked = ?, test_submitted = ?,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        JSON.stringify(input.form), input.step, Number(input.locked), Number(input.testSubmitted), id);
    }
    return getSetupDraft(id, owner)!;
  });
}
export function discardSetupDraft(id: string, owner: DraftOwner): boolean {
  return getDb().run('DELETE FROM agent_setup_drafts WHERE id = ? AND workspace_id = ? AND actor_id = ?',
    id, owner.workspaceId, owner.actorId).changes > 0;
}
