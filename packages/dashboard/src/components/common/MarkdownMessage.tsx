import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkLabelStrong } from '../../lib/remarkLabelStrong';

/** The same renderer handles partial streamed text and persisted final answers.
 * Raw HTML is disabled; Markdown's default URL sanitization stays enabled.
 */
export const MarkdownMessage = memo(function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="min-w-0 text-sm leading-6 text-app-secondary [overflow-wrap:anywhere]
      [&_p]:my-3 [&>:first-child]:mt-0 [&>:last-child]:mb-0
      [&_strong]:font-semibold [&_strong]:text-app-primary
      [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-semibold
      [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold
      [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold
      [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6
      [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1
      [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:pl-4
      [&_hr]:my-4 [&_hr]:border-border
      [&_code]:rounded [&_code]:bg-surface-hover [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs
      [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-background [&_pre]:p-3
      [&_pre_code]:bg-transparent [&_pre_code]:p-0
      [&_a]:text-accent-light [&_a]:underline [&_a]:underline-offset-2">
      <Markdown
        remarkPlugins={[remarkGfm, remarkLabelStrong]}
        skipHtml
        components={{
          table: ({ children }) => (
            <div className="my-4 max-w-full overflow-x-auto rounded-lg border border-border" tabIndex={0} role="region" aria-label="Response table">
              <table className="w-full min-w-[560px] border-collapse text-left text-xs leading-5">{children}</table>
            </div>
          ),
          th: ({ children, style }) => <th style={style} className="border-b border-border bg-surface-hover px-3 py-2.5 font-semibold text-app-primary">{children}</th>,
          td: ({ children, style }) => <td style={style} className="border-b border-border/60 px-3 py-2.5 align-top">{children}</td>,
          a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          // Do not automatically fetch model-supplied remote images/tracking URLs.
          img: ({ src, alt }) => <a href={src} target="_blank" rel="noopener noreferrer">{alt || 'View image'}</a>,
        }}
      >{content}</Markdown>
    </div>
  );
});
