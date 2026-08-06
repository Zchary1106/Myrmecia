import type { Pipeline } from '../types.js';
import { getMemoryService } from '../memory/memory-service.js';

/**
 * Context Manager
 * Builds optimized context for downstream pipeline stages.
 * - Previous stages: summary only (saves tokens)
 * - Direct dependency stages: full output (supports parallel workflow branches)
 * - Shared project context injected
 * - Relevant long-term memory recalled (semantic + procedural + episodic)
 */
export class ContextManager {
  /** Build optimized input for a pipeline stage */
  buildStageInput(pipeline: Pipeline, stageIndex: number): string {
    const parts: string[] = [];

    // 1. Project context header
    parts.push(`# Project: ${pipeline.name}\nWorkspace ID: ${pipeline.workspaceId || 'default'}\nOriginal requirement: ${pipeline.input}\n`);

    // 2. Previous stages — summaries only (not full output)
    if (stageIndex > 1) {
      parts.push('## Previous Stage Summaries');
      for (let i = 0; i < stageIndex - 1; i++) {
        const stage = pipeline.stages[i];
        if (stage.status === 'done' && stage.output) {
          const summary = this.summarize(stage.output, 500);
          parts.push(`### Stage ${i}: ${stage.name}\n${summary}`);
        }
      }
    }

    // 3. Direct dependencies — full output. A stage with explicit `dependsOn`
    // can receive several upstream deliverables produced in parallel. Fall
    // back to the immediately preceding stage for legacy sequential templates.
    const currentStage = pipeline.stages[stageIndex];
    const dependencyIndices = currentStage.dependsOn ?? (stageIndex > 0 ? [stageIndex - 1] : []);
    const dependencyOutputs = dependencyIndices
      .map(index => pipeline.stages[index])
      .filter((stage): stage is NonNullable<typeof stage> => Boolean(stage?.output))
      .map(stage => `## Detailed Input from: ${stage.name}\n${stage.output}`);

    if (dependencyOutputs.length > 0) {
      parts.push(...dependencyOutputs);
    }

    // 4. Persisted human approvals — downstream stages must never infer
    // approval from an LLM-produced JSON blob.
    const approvals = pipeline.stages
      .filter(stage => stage.approval)
      .map(stage => ({
        stageIndex: stage.index,
        stageName: stage.name,
        ...stage.approval,
      }));
    if (approvals.length > 0) {
      parts.push(`## Verified Human Approval Records\n${JSON.stringify(approvals, null, 2)}`);
    }

    // 5. Current stage instruction
    if (currentStage.promptTemplate) {
      const stageInput = dependencyOutputs.length > 0
        ? dependencyOutputs.join('\n\n---\n\n')
        : pipeline.input;
      parts.push(`## Your Task\n${currentStage.promptTemplate.replace('{input}', stageInput)}`);
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * Like {@link buildStageInput} but additionally injects a relevant long-term
   * memory block (semantic facts, procedural lessons, past episodes) scoped to
   * the pipeline's workspace. Falls back to the plain input on any failure.
   */
  async buildStageInputWithMemory(pipeline: Pipeline, stageIndex: number): Promise<string> {
    const base = this.buildStageInput(pipeline, stageIndex);
    try {
      const stage = pipeline.stages[stageIndex];
      const query = `${pipeline.input}\n${stage?.name ?? ''}`.trim();
      const block = await getMemoryService().buildContextBlock({
        query,
        scope: pipeline.workspaceId ? { workspace: pipeline.workspaceId } : undefined,
        types: ['semantic', 'procedural', 'episodic'],
        heading: '## Relevant Memory (from past work)',
      });
      return block ? `${base}\n\n---\n\n${block}` : base;
    } catch {
      return base;
    }
  }

  /** Create a summary of text, keeping it under maxChars */
  private summarize(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;

    // Take first and last portions
    const half = Math.floor(maxChars / 2);
    return text.slice(0, half) + '\n\n[... truncated ...]\n\n' + text.slice(-half);
  }
}

export const contextManager = new ContextManager();
