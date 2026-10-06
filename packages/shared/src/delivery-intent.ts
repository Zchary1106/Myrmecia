/** Mentioning a platform as a source does not ask for a publishable post. */
export function isPublicationRequest(input: string, conversationInput?: string): boolean {
  // Brief follow-ups inherit the original user goal, never the previous
  // assistant's publishing template. Specific new requests are classified anew.
  if (conversationInput && /^(?:继续(?:吧|写)?|再短一点|短一点|再详细一点|continue|make it shorter)[。.!！\s]*$/i.test(input.trim())) {
    const originalGoal = /^Original goal:\s*(.+)$/m.exec(conversationInput)?.[1];
    if (originalGoal) return isPublicationRequest(originalGoal);
  }
  const text = input.replace(/(?:不要|不用|无需|不需要)[^，。！？\n]*(?:笔记|文案|卡片|发布|标签|CTA)[^，。！？\n]*/gi, '')
    .replace(/\b(?:do not|don't|no need to)\b[^,.!?\n]*(?:post|caption|carousel)[^,.!?\n]*/gi, '');
  return /(?:写|撰写|创作|生成|制作|产出|发布|润色|修改|缩短|改短|改写|优化|做)[^。！？\n]{0,24}(?:小红书(?:笔记|文案|内容|图文)|发布稿|种草文案|营销文案|图文笔记|卡片|图卡|封面|口播|分镜|帖子)/i.test(text)
    || /(?:写|创作|发布|改写)[^。！？\n]{0,12}(?:一篇|这篇)?(?:笔记|文案)/.test(text)
    || /\b(?:write|draft|create|publish|edit)\b[^.!?\n]{0,40}\b(?:post|caption|social content|carousel)\b/i.test(text);
}
