import { describe, expect, it } from 'vitest';
import type { Pipeline, Task, TaskExecution } from '@myrmecia/shared';
import { compactTaskTitle, homeConversations, plainResultPreview } from '../src/components/home/homeActivity';

const task = (id: string, changes: Partial<Task> = {}): Task => ({
  id, title: 'Research hotels', description: '', input: '', mode: 'direct', status: 'done',
  priority: 'normal', createdBy: 'user', retryCount: 0, maxRetries: 1, dependsOn: [],
  createdAt: '2026-09-18T10:00:00Z', ...changes,
});

describe('Home conversation summaries', () => {
  it('groups descendants, continuations and retries by their root, not by matching titles', () => {
    const result = homeConversations([
      task('root'), task('child', { createdBy: 'master', parentTaskId: 'root' }),
      task('followup', { parentTaskId: 'child', retryCount: 2 }),
      task('independent'),
      task('plan', { title: 'Plan: Research hotels', createdBy: 'master' }),
    ], [], []);
    expect(result).toHaveLength(2);
    expect(result.find(item => item.id === 'task:root')?.turns).toBe(2);
    expect(result.some(item => item.id === 'task:independent')).toBe(true);
  });

  it('groups workflow stages into one conversation using the pipeline name', () => {
    const result = homeConversations([
      task('stage1', { pipelineId: 'workflow' }), task('stage2', { pipelineId: 'workflow' }),
    ], [{ id: 'workflow', name: 'Publish article' } as Pipeline], []);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Publish article');
  });

  it.each(['paused', 'awaiting_retry', 'blocked'] as const)('does not classify a %s workflow as completed just because its latest task finished', status => {
    const result = homeConversations([task('stage', { pipelineId: 'workflow' })],
      [{ id: 'workflow', name: 'Waiting workflow', status } as Pipeline], []);
    expect(result[0].active).toBe(true);
    expect(result[0].workflowStatus).toBe(status);
    expect(result[0].activity.status).toBe('done');
  });

  it.each(['pending', 'queued', 'assigned', 'running', 'waiting_for_tool', 'review'] as const)('keeps %s work visible as in progress', status => {
    const result = homeConversations([task('root'), task('child', { parentTaskId: 'root', status })], [], []);
    expect(result[0].active).toBe(true);
    expect(result[0].activity.id).toBe('child');
  });

  it('uses the real execution recipient and newest activity, not a hardcoded Master Agent', () => {
    const result = homeConversations([
      task('old', { assigneeId: 'writer' }),
      task('recent', { completedAt: '2026-09-20 01:00:00' }),
    ], [], [], [{ taskId: 'recent', agentDefId: 'researcher', startedAt: '2026-09-20T00:00:00Z' } as TaskExecution]);
    expect(result[0].task.id).toBe('recent');
    expect(result[0].agent).toBe('researcher');
    expect(result[0].updatedAt).toBe(Date.parse('2026-09-20T01:00:00Z'));
    expect(result[0].active).toBe(false);
  });

  it('does not invent an owner when no Agent was assigned', () => {
    expect(homeConversations([task('root')], [], [])[0].agent).toBe('No Agent recorded');
  });

  it('handles an unavailable parent and malformed parent cycles without hanging', () => {
    const result = homeConversations([
      task('orphan', { parentTaskId: 'missing' }), task('a', { parentTaskId: 'b' }), task('b', { parentTaskId: 'a' }),
    ], [], []);
    expect(result.find(item => item.task.id === 'orphan')).toBeDefined();
  });

  it('renders a short plain-text preview instead of Markdown syntax or raw structured data', () => {
    expect(plainResultPreview('### **证据状态**：报价未核实。\n查看[来源](https://example.com) 和 `pnpm`。')).toBe('证据状态：报价未核实。 查看来源 和 pnpm。');
    expect(plainResultPreview('{"unfamiliar": "payload"}')).not.toContain('{');
    expect(plainResultPreview('Done\n```js\nconsole.log(1)\n```')).toBe('Done');
  });

  it('shortens titles without changing the stored task', () => {
    const original = '帮我收集仙本那水屋推荐，从价格、交通与优势进行比较，并规划适合两个人的跳岛路线，还需要提供参考资料';
    expect(compactTaskTitle(original)).toBe('帮我收集仙本那水屋推荐');
    expect(compactTaskTitle('')).toBe('Untitled conversation');
  });
});
