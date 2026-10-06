import { useMemo } from 'react';
import { isPublicationRequest } from '@myrmecia/shared';
import { MarkdownMessage } from '../common/MarkdownMessage';

/** Lossless presentation of legacy writer output; persisted content is untouched. */
export function splitResearchAnswer(content: string) {
  const body: string[] = [];
  const appendix: string[] = [];
  const limitations: string[] = [];
  let inAppendix = false;
  let fence: string | undefined;
  for (const line of content.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      (inAppendix ? appendix : body).push(line);
      continue;
    }
    if (!fence) {
      if (/^\s*\*\*(?:资料说明|资料限制|来源说明)[：:]\s*\*\*/.test(line)) {
        limitations.push(line);
        continue;
      }
      if (/^\s*\*\*(?:内容\s*ID|模式|搜索意图|标题|CTA|标签|视觉主题)[：:]\s*\*\*/i.test(line)) {
        appendix.push(line);
        continue;
      }
      if (/^#{1,6}\s*(?:\d+\s*张)?卡片(?:脚本|方案|文案)/.test(line)) {
        inAppendix = true;
      } else if (/^#{1,6}\s/.test(line)) {
        inAppendix = false;
      }
    }
    (inAppendix ? appendix : body).push(line);
  }
  return { body: body.join('\n').trim(), appendix: appendix.join('\n').trim(), limitations: limitations.join('\n\n').trim() };
}

export function ResearchAnswer({ content, request, agentId, conversationInput }: { content: string; request: string; agentId?: string; conversationInput?: string }) {
  const legacyResearch = agentId === 'xiaohongshu-writer' && !isPublicationRequest(request, conversationInput);
  const parts = useMemo(() => legacyResearch ? splitResearchAnswer(content) : null, [content, legacyResearch]);
  if (!parts || (!parts.appendix && !parts.limitations)) return <MarkdownMessage content={content} />;
  return <div className="space-y-4">
    {parts.limitations && <aside aria-label="Response evidence limitations" className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold text-app-primary">资料限制 · 原回答说明</h3>
      <MarkdownMessage content={parts.limitations} />
    </aside>}
    <MarkdownMessage content={parts.body} />
    {parts.appendix && <details className="rounded-lg border border-border px-3 py-2 text-xs text-app-muted">
      <summary className="app-focus cursor-pointer">创作附录（原回答中的发布模板）</summary>
      <div className="mt-3"><MarkdownMessage content={parts.appendix} /></div>
    </details>}
    <details className="text-xs text-app-muted">
      <summary className="app-focus cursor-pointer">查看完整原始回答</summary>
      <div className="mt-3"><MarkdownMessage content={content} /></div>
    </details>
  </div>;
}
