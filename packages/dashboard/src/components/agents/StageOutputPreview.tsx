import type { ReactNode } from 'react';

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*.*?\*\*|`.*?`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index} className="font-semibold text-gray-100">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index} className="rounded bg-black/30 px-1 py-0.5 font-mono text-[0.9em] text-amber-200">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

export function StageOutputPreview({ output }: { output: string }) {
  const trimmed = output.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return (
      <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-background p-4 font-mono text-xs leading-6 text-gray-300">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } catch {
    // Most human-readable stage outputs are Markdown rather than strict JSON.
  }

  return (
    <article className="max-h-[520px] overflow-auto rounded-xl border border-border bg-background px-5 py-4 text-sm leading-7 text-gray-300">
      {trimmed.split(/\r?\n/).map((line, index) => {
        const value = line.trim();
        if (!value) return <div key={index} className="h-3" />;
        if (/^---+$/.test(value)) return <hr key={index} className="my-4 border-border" />;

        const heading = value.match(/^(#{1,4})\s+(.+)$/);
        if (heading) {
          const level = heading[1].length;
          const className = level === 1
            ? 'mb-3 mt-2 text-xl font-bold text-white'
            : level === 2
              ? 'mb-2 mt-5 text-lg font-bold text-gray-100'
              : 'mb-1 mt-4 text-base font-semibold text-gray-100';
          return <div key={index} className={className}>{inlineMarkdown(heading[2])}</div>;
        }

        const bullet = value.match(/^[-*]\s+(.+)$/);
        if (bullet) {
          return (
            <div key={index} className="flex gap-2 pl-2">
              <span className="text-accent-light">•</span>
              <span>{inlineMarkdown(bullet[1])}</span>
            </div>
          );
        }

        const numbered = value.match(/^(\d+)[.)]\s+(.+)$/);
        if (numbered) {
          return (
            <div key={index} className="flex gap-2 pl-2">
              <span className="min-w-5 font-semibold text-accent-light">{numbered[1]}.</span>
              <span>{inlineMarkdown(numbered[2])}</span>
            </div>
          );
        }

        if (value.startsWith('>')) {
          return (
            <blockquote key={index} className="my-2 border-l-2 border-accent/50 bg-accent/5 px-3 py-2 text-gray-400">
              {inlineMarkdown(value.replace(/^>\s?/, ''))}
            </blockquote>
          );
        }

        return <p key={index}>{inlineMarkdown(value)}</p>;
      })}
    </article>
  );
}
