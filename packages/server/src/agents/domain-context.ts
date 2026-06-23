import type { AgentDefinition, DomainPack, Task } from '../types.js';
import { resolveDomainForAgent } from './domain-registry.js';
import { searchKnowledge } from '../knowledge/rag.js';
import { logger } from '../lib/logger.js';

/**
 * Domain context helpers — turn a Domain Pack into prompt material.
 *
 * Two injection points (shared by the TS loop and the Python runtime):
 *  - buildDomainOverlay(): persona + guidelines + terminology + disclaimer,
 *    prepended to the system prompt.
 *  - buildDomainKnowledgeBlock(): top-K retrieved knowledge-base chunks for the
 *    task, prepended to the user input.
 */

/** Resolve the domain pack that applies to this execution (explicit task.domainId wins). */
export function resolveDomainForTask(agent: AgentDefinition, task: Task): DomainPack | undefined {
  try {
    return resolveDomainForAgent(agent.id, task.domainId, task.workspaceId);
  } catch {
    return undefined;
  }
}

/** Build the system-prompt overlay block for a domain (empty string if none). */
export function buildDomainOverlay(domain?: DomainPack): string {
  if (!domain) return '';
  const parts: string[] = [`## 领域：${domain.name}`, domain.persona.trim()];

  if (domain.guidelines.length) {
    parts.push(`### 作答准则\n${domain.guidelines.map(g => `- ${g}`).join('\n')}`);
  }
  const terms = Object.entries(domain.terminology || {});
  if (terms.length) {
    parts.push(`### 术语\n${terms.map(([k, v]) => `- ${k}：${v}`).join('\n')}`);
  }
  if (domain.tone) parts.push(`### 语气\n${domain.tone}`);
  if (domain.disclaimer) {
    parts.push(`### 免责声明（必须包含在最终输出中）\n${domain.disclaimer}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Prepend a domain overlay to an existing system prompt. */
export function applyDomainOverlay(systemPrompt: string, domain?: DomainPack): string {
  const overlay = buildDomainOverlay(domain);
  return overlay ? `${overlay}\n\n---\n\n${systemPrompt}` : systemPrompt;
}

/**
 * Retrieve and render the domain knowledge block for a task. Returns '' when the
 * domain has retrieval disabled, no bound knowledge, or nothing relevant.
 */
export async function buildDomainKnowledgeBlock(domain: DomainPack | undefined, query: string, workspaceId?: string): Promise<string> {
  if (!domain || !domain.retrieval?.enabled) return '';
  try {
    const hits = await searchKnowledge(
      workspaceId || 'default',
      query,
      domain.retrieval.topK ?? 6,
      { domainId: domain.id },
    );
    const usable = hits.filter(h => h.score >= (domain.retrieval.minScore ?? 0) && h.content.trim());
    if (!usable.length) return '';
    // Label each chunk with a citation marker [n] tied to its source document so
    // the agent can cite, and surface a sources list for traceability.
    const body = usable
      .map((h, i) => `[${i + 1}] 来源：《${h.title}》（相关度 ${h.score.toFixed(2)}）\n${h.content.trim()}`)
      .join('\n\n');
    const sources = usable
      .map((h, i) => `[${i + 1}] 《${h.title}》（${h.documentId}）`)
      .join('\n');
    return [
      `## 领域知识（检索自「${domain.name}」知识库）`,
      '回答时请用 [编号] 标注你引用的来源片段。',
      '',
      body,
      '',
      '### 引用来源',
      sources,
    ].join('\n');
  } catch (err: any) {
    logger.warn({ err: err.message, domainId: domain.id }, 'domain knowledge retrieval failed');
    return '';
  }
}

/** Prepend a domain knowledge block to the task input. */
export async function applyDomainKnowledge(input: string, domain: DomainPack | undefined, workspaceId?: string): Promise<string> {
  const block = await buildDomainKnowledgeBlock(domain, input, workspaceId);
  return block ? `${block}\n\n---\n\n## 任务\n${input}` : input;
}
