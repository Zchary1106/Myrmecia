import type { AgentSetupForm } from './agent-setup.js';

export function agentSetupPayload(form: AgentSetupForm) {
  const csv = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
  return {
    name: form.name.trim(), role: form.role.trim(), emoji: form.emoji.trim() || '🤖',
    description: form.description.trim(), whenToUse: form.whenToUse.trim(),
    capabilities: csv(form.capabilities), triggers: csv(form.triggers),
    allowedTools: form.allowedTools, model: form.model, maxTurns: form.maxTurns,
    config: { model: form.model, maxTurns: form.maxTurns, timeout: form.timeout, maxConcurrent: form.maxConcurrent,
      allowedTools: form.allowedTools, systemInstructions: form.systemInstructions,
      ...(form.contractEnabled ? { contract: {
        schemaVersion: '1.0' as const, agentId: '__new_agent__', role: form.role.trim(),
        responsibility: { summary: form.description.trim(), owns: form.owns, doesNotOwn: form.doesNotOwn, escalatesTo: form.escalatesTo },
        inputs: form.inputs, outputs: form.outputs, skills: [], tools: form.allowedTools,
        quality: { definitionOfDone: form.definitionOfDone },
      } } : {}) },
  };
}
