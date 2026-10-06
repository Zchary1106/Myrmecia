/**
 * buildAgentSystemPrompt — composes the agent system prompt from the runtime
 * profile and an optional skill override. Shared by both executor paths, so its
 * output is worth pinning down.
 */

import { describe, it, expect } from 'vitest';
import type { AgentDefinition } from '../src/types.js';
import { buildAgentSystemPrompt } from '../src/agents/agent-prompt.js';
import { isPublicationRequest } from '@myrmecia/shared';

function agent(o: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'dev',
    name: 'Dev Agent',
    role: 'developer',
    description: 'Writes production code',
    whenToUse: 'Implementation tasks',
    capabilities: ['typescript', 'react'],
    ...o,
  } as AgentDefinition;
}

describe('buildAgentSystemPrompt', () => {
  it('uses a research contract instead of a mandatory publishing template for advice', () => {
    const prompt = buildAgentSystemPrompt(agent({ id: 'xiaohongshu-writer' }), ['mcp__xiaohongshu__search_feeds'],
      '# Mandatory publishing template\nSENTINEL_CARD_TEMPLATE', {
        mode: 'direct', description: '帮我从小红书收集水屋价格推荐，规划一下跳岛路线', input: 'same request',
      });
    expect(prompt).toContain('Research answer contract');
    expect(prompt).not.toContain('SENTINEL_CARD_TEMPLATE');
    expect(prompt).toContain('write "未核实" for the price');
    expect(prompt).toContain('State important evidence gaps at the START');
    expect(prompt).toContain('explicitly label any planning assumption');
  });

  it('preserves explicit publication and pipeline skill contracts', () => {
    const writer = agent({ id: 'xiaohongshu-writer' });
    expect(buildAgentSystemPrompt(writer, [], 'SENTINEL_CARD_TEMPLATE', {
      mode: 'direct', description: '帮我写一篇小红书笔记和卡片', input: '',
    })).toContain('SENTINEL_CARD_TEMPLATE');
    expect(buildAgentSystemPrompt(writer, [], 'SENTINEL_CARD_TEMPLATE', {
      mode: 'direct', description: '整理资料', input: '', pipelineId: 'content-pipeline',
    })).toContain('SENTINEL_CARD_TEMPLATE');
    expect(buildAgentSystemPrompt(writer, [], 'SENTINEL_CARD_TEMPLATE', {
      mode: 'direct', description: '继续', input: 'Original goal: 帮我写一篇小红书笔记\n\nNEW user message:\n继续',
    })).toContain('SENTINEL_CARD_TEMPLATE');
    expect(buildAgentSystemPrompt(writer, [], 'SENTINEL_CARD_TEMPLATE', {
      mode: 'direct', description: '继续', input: 'Original goal: 查询水屋价格\n\nRecent turns:\n写一篇小红书笔记\n\nNEW user message:\n继续',
    })).not.toContain('SENTINEL_CARD_TEMPLATE');
  });

  it.each([
    ['从小红书笔记里查一下住宿价格', false],
    ['帮我收集水屋推荐，可以从小红书寻找资料', false],
    ['不要生成卡片，只帮我查一下价格', false],
    ['帮我写一篇小红书笔记', true],
    ['制作小红书内容和封面', true],
    ['Write a post about the itinerary', true],
    ["Don't write a post, just research prices", false],
  ])('distinguishes sources from publishing intent: %s', (request, publication) => {
    expect(isPublicationRequest(request)).toBe(publication);
  });

  it('composes a runtime profile from the agent fields', () => {
    const prompt = buildAgentSystemPrompt(agent(), ['file_read', 'shell_exec']);
    expect(prompt).toContain('You are Dev Agent, a developer agent.');
    expect(prompt).toContain('Mission: Writes production code');
    expect(prompt).toContain('When to use: Implementation tasks');
    expect(prompt).toContain('Capabilities: typescript, react');
    expect(prompt).toContain('Allowed tools: file_read, shell_exec');
  });

  it('omits the allowed-tools line when there are no tools', () => {
    const prompt = buildAgentSystemPrompt(agent(), []);
    expect(prompt).not.toContain('Allowed tools:');
  });

  it('omits optional lines that are absent', () => {
    const prompt = buildAgentSystemPrompt(
      agent({ description: undefined, whenToUse: '', capabilities: [] }),
      [],
    );
    expect(prompt).toContain('You are Dev Agent, a developer agent.');
    expect(prompt).not.toContain('Mission:');
    expect(prompt).not.toContain('When to use:');
    expect(prompt).not.toContain('Capabilities:');
  });

  it('layers a resolved skill over the runtime profile', () => {
    const prompt = buildAgentSystemPrompt(agent(), ['file_read'], '# Skill\nDo the thing.');
    expect(prompt.startsWith('# Skill\nDo the thing.')).toBe(true);
    expect(prompt).toContain('## Runtime Profile Override');
    expect(prompt).toContain('You are Dev Agent, a developer agent.');
  });

  it('returns just the runtime profile when no skill content and no skill path', () => {
    const prompt = buildAgentSystemPrompt(agent({ skillPath: undefined }), []);
    expect(prompt).not.toContain('## Runtime Profile Override');
    expect(prompt).toContain('You are Dev Agent, a developer agent.');
  });
});
