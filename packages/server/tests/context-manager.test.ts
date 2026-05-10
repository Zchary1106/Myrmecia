import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/pipelines/context-manager.js';
import type { Pipeline } from '../src/types.js';

const cm = new ContextManager();

function makePipeline(overrides?: Partial<Pipeline>): Pipeline {
  return {
    id: 'pipe_test',
    name: 'Test Pipeline',
    status: 'running',
    currentStageIndex: 0,
    gateMode: 'auto',
    input: 'Build a weather app',
    createdAt: new Date().toISOString(),
    stages: [
      { index: 0, name: 'Spec', agentRole: 'pm', status: 'done', output: 'This is the spec output.', promptTemplate: 'Write spec for: {input}' },
      { index: 1, name: 'Design', agentRole: 'ui', status: 'done', output: 'This is the design output.', promptTemplate: 'Design UI for: {input}' },
      { index: 2, name: 'Code', agentRole: 'dev', status: 'pending', promptTemplate: 'Implement: {input}' },
      { index: 3, name: 'Test', agentRole: 'qa', status: 'pending', promptTemplate: 'Test: {input}' },
    ],
    ...overrides,
  };
}

describe('ContextManager', () => {
  it('should build first stage input from pipeline input', () => {
    const pipeline = makePipeline();
    const input = cm.buildStageInput(pipeline, 0);
    expect(input).toContain('Build a weather app');
    expect(input).toContain('Test Pipeline');
  });

  it('should include previous stage output for stage 1', () => {
    const pipeline = makePipeline();
    const input = cm.buildStageInput(pipeline, 1);
    expect(input).toContain('spec output');
  });

  it('should include summaries and full predecessor for stage 2+', () => {
    const pipeline = makePipeline();
    const input = cm.buildStageInput(pipeline, 2);
    // Should have summary of stage 0
    expect(input).toContain('Stage 0: Spec');
    // Should have full output from stage 1 (direct predecessor)
    expect(input).toContain('design output');
  });

  it('should include prompt template with substitution', () => {
    const pipeline = makePipeline();
    const input = cm.buildStageInput(pipeline, 0);
    expect(input).toContain('Write spec for:');
  });

  it('should handle pipeline with no previous stages gracefully', () => {
    const pipeline = makePipeline({ stages: [
      { index: 0, name: 'Only', agentRole: 'dev', status: 'pending', promptTemplate: 'Do: {input}' },
    ]});
    const input = cm.buildStageInput(pipeline, 0);
    expect(input).toContain('Build a weather app');
  });
});
