import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentDefinition, Task } from '../types.js';
import { isPublicationRequest } from '@myrmecia/shared';
import { withInputRequestProtocol } from './completion-control.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function usesResearchAnswerContract(agent: AgentDefinition, task?: Pick<Task, 'mode' | 'input' | 'description' | 'pipelineId'>): boolean {
  return agent.id === 'xiaohongshu-writer' && task?.mode === 'direct' && !task.pipelineId
    && !isPublicationRequest(task.description || task.input, task.input);
}

/**
 * Build the base system prompt for an agent execution — shared by the TypeScript
 * loop and the Python runtime so the two paths can't drift.
 *
 * Layers (highest priority last): a runtime profile derived from the agent's
 * DB-editable fields, overridden by a resolved skill (an assigned skill version's
 * content, or the agent's skill markdown file). Domain overlays are applied
 * separately by the caller via {@link applyDomainOverlay}.
 */
export function buildAgentSystemPrompt(
  agent: AgentDefinition,
  allowedTools: string[],
  runtimeSkillContent?: string,
  task?: Pick<Task, 'mode' | 'input' | 'description' | 'pipelineId'>,
): string {
  const runtimeProfile = [
    `You are ${agent.name}, a ${agent.role} agent.`,
    agent.description ? `Mission: ${agent.description}` : '',
    agent.whenToUse ? `When to use: ${agent.whenToUse}` : '',
    agent.capabilities?.length ? `Capabilities: ${agent.capabilities.join(', ')}` : '',
    allowedTools.length
      ? `Allowed tools: ${allowedTools.join(', ')}. Use them when they improve factual accuracy, research depth, formatting, or generated assets.`
      : '',
  ].filter(Boolean).join('\n\n');

  // A platform used as a research source is not an instruction to publish.
  // Do not load the writer's mandatory marketing template for direct advice.
  if (usesResearchAnswerContract(agent, task)) {
    return withInputRequestProtocol(`${runtimeProfile}\n\n## Research answer contract
The user requested research, comparison or advice, NOT a publishable social-media post.
Answer the user's question directly in their language. Do not output content IDs, note modes, search-intent metadata, CTA, hashtags, card scripts, visual themes, or a 1000-character publishing limit. Do not generate images unless explicitly requested.

Evidence rules:
- Use permitted read-only research tools. Xiaohongshu authentication is checked automatically. Search sequentially (at most two searches and two note details); stop querying a source after repeated failures.
- Separate source-backed findings, user-generated claims, general background, assumptions, and unknowns.
- Cite the actual source URL next to each specific recommendation and quote/price claim, and state the date and pricing unit when available.
- Search snippets and creator posts are leads, not verified availability or a current quote. Never invent source URLs.
- If no current quote was retrieved, write "未核实" for the price. Do not invent numeric ranges or label unsupported numbers "历史常见价格".
- Do not infer a cheapest/best option, a current exchange rate, availability, or compliance with the user's budget from missing evidence.
- State important evidence gaps at the START, not buried after a confident conclusion. Tool failure does not prove the user's budget is impossible.
- If travel dates, duration, occupancy, currency or budget units were not supplied, explicitly label any planning assumption; do not present it as a user requirement.

Response shape:
1. Evidence status and a useful bounded conclusion.
2. Candidate comparison: known advantages, budget fit or "未核实", evidence/source and open questions. Include concrete results when the tools actually retrieved them.
3. A suggested plan under clearly stated assumptions, followed by the few details needed to finalize it.
4. Sources and unresolved checks. A partial answer must be visibly partial; never claim the research was completed when evidence is missing.

Use standard Markdown. Put the colon outside bold labels, e.g. "**结论**：内容", with blank lines around tables and lists.
`, task);
  }

  if (runtimeSkillContent) {
    return withInputRequestProtocol(`${runtimeSkillContent}\n\n## Runtime Profile Override\n${runtimeProfile}`, task);
  }

  if (agent.skillPath) {
    try {
      const skillRoot = process.env.MYRMECIA_RESOURCE_ROOT || join(__dirname, '../../../../');
      const skillPrompt = readFileSync(join(skillRoot, agent.skillPath), 'utf-8');
      return withInputRequestProtocol(`${skillPrompt}\n\n## Runtime Profile Override\n${runtimeProfile}`, task);
    } catch { /* fall through to the runtime profile */ }
  }

  return withInputRequestProtocol(runtimeProfile, task);
}
