import type { Task } from '../types.js';

/** Only unambiguous standalone small talk. Unknown or compound work fails closed. */
export function isSimpleConversation(task: Pick<Task, 'title' | 'input' | 'description' | 'mode' | 'pipelineId' | 'parentTaskId'> & { createdBy?: string }): boolean {
  if (task.mode !== 'direct' || task.pipelineId) return false;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[!?！？，,.。]+$/u, '').trim();
  let input = normalize(task.input || '');
  if (task.parentTaskId) {
    // Only the server's bounded user-continuation envelope, not autonomous
    // implementation/QA children or arbitrary conflicting prompt fields.
    if (task.createdBy !== 'user'
      || !task.input.startsWith('Continue the conversation below and answer the NEW user message.')
      || !task.input.includes(`Session root: ${task.parentTaskId}\n\n`)
      || !task.input.trim().endsWith(`NEW user message:\n${task.description.trim()}`)) return false;
    input = normalize(task.description);
  }
  if (normalize(task.title) !== input) return false;
  if (task.description?.trim() && normalize(task.description) !== input) return false;
  return /^(hello|hi|hey|thanks|thank you|你好|您好|嗨|谢谢|早上好|晚上好|你可以帮我干什么|你能做什么|what can you do|how can you help(?: me)?)$/u.test(input);
}
