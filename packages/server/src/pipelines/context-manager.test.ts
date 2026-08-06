import { describe, expect, it } from 'vitest';
import { ContextManager } from './context-manager.js';
import type { Pipeline } from '../types.js';

function pipeline(): Pipeline {
  return {
    id: 'pipe-social',
    name: 'Social three lanes',
    status: 'running',
    currentStageIndex: 5,
    gateMode: 'manual',
    input: 'AI efficiency topic',
    createdAt: '2026-08-04T00:00:00.000Z',
    stages: [
      { index: 0, name: 'Research', agentRole: 'trend-scout', status: 'done', output: 'evidence pack' },
      { index: 1, name: 'Core', agentRole: 'content-strategist', status: 'done', output: 'core package' },
      { index: 2, name: 'Douyin', agentRole: 'douyin-writer', status: 'done', output: 'douyin draft' },
      { index: 3, name: 'XHS', agentRole: 'xiaohongshu-writer', status: 'done', output: 'xhs draft' },
      { index: 4, name: 'WeChat', agentRole: 'wechat-writer', status: 'done', output: 'wechat draft' },
      {
        index: 5,
        name: 'Compliance',
        agentRole: 'social-compliance-reviewer',
        status: 'pending',
        dependsOn: [2, 3, 4],
        promptTemplate: 'Review these drafts:\n{input}',
      },
    ],
  };
}

describe('ContextManager parallel dependencies', () => {
  it('passes every explicit dependency output to a fan-in stage', () => {
    const input = new ContextManager().buildStageInput(pipeline(), 5);

    expect(input).toContain('Detailed Input from: Douyin');
    expect(input).toContain('douyin draft');
    expect(input).toContain('Detailed Input from: XHS');
    expect(input).toContain('xhs draft');
    expect(input).toContain('Detailed Input from: WeChat');
    expect(input).toContain('wechat draft');
  });

  it('does not use an unrelated immediately preceding stage when dependencies are explicit', () => {
    const value = pipeline();
    value.stages[4].output = 'unrelated direct predecessor';
    value.stages[5].dependsOn = [2, 3];

    const input = new ContextManager().buildStageInput(value, 5);
    expect(input).toContain('douyin draft');
    expect(input).toContain('xhs draft');
    expect(input).not.toContain('Detailed Input from: WeChat\nunrelated direct predecessor');
  });

  it('injects persisted human approval records into downstream context', () => {
    const value = pipeline();
    value.stages[1].approval = {
      actorId: 'operator-1',
      actorRole: 'operator',
      actorSource: 'local',
      approvedAt: '2026-08-04T00:00:00.000Z',
      contentHash: 'abc123',
      kind: 'content',
    };

    const input = new ContextManager().buildStageInput(value, 5);
    expect(input).toContain('Verified Human Approval Records');
    expect(input).toContain('operator-1');
    expect(input).toContain('abc123');
  });
});
