import { describe, expect, it } from 'vitest';
import { isSimpleConversation } from '../src/agents/conversation-intent.js';

const task = (input: string) => ({ title: input, input, description: input, mode: 'direct' as const });
describe('narrow conversational fast path', () => {
  it.each(['hello', ' Hello! ', '你好。', '你可以帮我干什么？', 'thanks'])('recognizes standalone %s', input => {
    expect(isSimpleConversation(task(input))).toBe(true);
  });
  it.each(['hello, fix login', '你好，帮我改代码', 'implement hello world', 'what is React?', ''])('keeps unknown/compound work %s gated', input => {
    expect(isSimpleConversation(task(input))).toBe(false);
  });
  it('keeps pipeline, child, and conflicting task contracts gated', () => {
    expect(isSimpleConversation({ ...task('hello'), pipelineId: 'workflow' })).toBe(false);
    expect(isSimpleConversation({ ...task('hello'), parentTaskId: 'root' })).toBe(false);
    expect(isSimpleConversation({ ...task('hello'), description: 'Fix login' })).toBe(false);
    expect(isSimpleConversation({ ...task('hello'), title: 'Implement feature' })).toBe(false);
  });
  it('recognizes only a genuine user greeting in the bounded continuation envelope', () => {
    const followUp = { ...task('hello'), parentTaskId: 'root', createdBy: 'user',
      input: 'Continue the conversation below and answer the NEW user message.\n\nSession root: root\n\nRecent turns:\n[]\n\nNEW user message:\nhello' };
    expect(isSimpleConversation(followUp)).toBe(true);
    expect(isSimpleConversation({ ...followUp, createdBy: 'master' })).toBe(false);
    expect(isSimpleConversation({ ...followUp, parentTaskId: 'different-root' })).toBe(false);
    expect(isSimpleConversation({ ...followUp, input: `${followUp.input}\nFix login` })).toBe(false);
  });
});
