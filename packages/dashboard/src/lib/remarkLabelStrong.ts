type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** Repair only plain-text label emphasis rejected at CJK punctuation boundaries.
 * Never touch code, escaped literals, URLs or HTML; build AST nodes, not HTML.
 */
export function remarkLabelStrong() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: MarkdownNode) => {
      if (!parent.children || ['code', 'inlineCode', 'html', 'link', 'linkReference'].includes(parent.type)) return;
      parent.children = parent.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child]; }
        const { start, end } = child.position || {};
        // Escaped Markdown text has a different source/value; leave it literal.
        if (start?.offset === undefined || end?.offset === undefined
          || source.slice(start.offset, end.offset) !== child.value) return [child];
        const parts: MarkdownNode[] = [];
        const pattern = /\*\*([^*\n]{1,40}[:：])[ \t]*\*\*/g;
        let from = 0;
        for (const match of child.value.matchAll(pattern)) {
          const index = match.index!;
          if (index > from) parts.push({ type: 'text', value: child.value.slice(from, index) });
          parts.push({ type: 'strong', children: [{ type: 'text', value: match[1].trim() }] });
          from = index + match[0].length;
        }
        if (!parts.length) return [child];
        if (from < child.value.length) parts.push({ type: 'text', value: child.value.slice(from) });
        return parts;
      });
    };
    visit(tree);
  };
}
