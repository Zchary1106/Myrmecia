import type { AgentDefinition, Task } from '../types.js';
import { listSessionDocuments } from '../knowledge/session-documents.js';
import { listExecutionArtifacts } from '../db/models/execution-artifact.js';

/** Match structured file requirements to scoped evidence, never infer it from prose. */
export function missingContractInput(agent: AgentDefinition, task: Task): string | undefined {
  const required = agent.config.contract?.inputs.filter(input => input.required !== false) || [];
  if (!required.length) return undefined;
  const documents = listSessionDocuments(task);
  const artifacts = listExecutionArtifacts({ workspaceId: task.workspaceId || 'default', taskId: task.id, limit: 1000 });
  const missing = required.filter(input => {
    // Text is the explicit user request. Typed files need a named uploaded/indexed source.
    if (input.kind === 'text') return !task.input.trim();
    return !documents.some(document => document.name === input.name)
      && !artifacts.some(artifact => artifact.name === input.name && artifact.kind === input.kind);
  });
  return missing.length ? `请补充职责契约要求的输入：${missing.map(input => input.name).join('、')}。请上传对应文件或绑定有效产物，再继续此会话。` : undefined;
}
