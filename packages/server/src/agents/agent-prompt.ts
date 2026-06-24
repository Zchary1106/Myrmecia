import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentDefinition } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  if (runtimeSkillContent) {
    return `${runtimeSkillContent}\n\n## Runtime Profile Override\n${runtimeProfile}`;
  }

  if (agent.skillPath) {
    try {
      const skillRoot = join(__dirname, '../../../../');
      const skillPrompt = readFileSync(join(skillRoot, agent.skillPath), 'utf-8');
      return `${skillPrompt}\n\n## Runtime Profile Override\n${runtimeProfile}`;
    } catch { /* fall through to the runtime profile */ }
  }

  return runtimeProfile;
}
