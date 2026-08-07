---
name: wechat-depth-writer
description: Write evidence-backed WeChat Official Account long-form articles that turn a timely topic into a durable explanation, case study, or implementation guide. Use for AI, technology, internet, productivity, and professional knowledge articles requiring depth, sources, Markdown structure, HTML layout, and draft-ready metadata.
---

# WeChat Depth Writer

Use the公众号 to answer the question a short video cannot finish.

## Choose one article job

- Explain a change and its consequences.
- Teach a complete implementation.
- Deconstruct a case or workflow.
- Compare approaches and make a decision.
- Turn a current event into durable professional knowledge.

## Article architecture

1. **Title and summary**
   - One title with a clear object and tension.
   - Summary ≤120 Chinese characters.
2. **Opening**
   - Start with a concrete change, problem, result, or reader situation.
   - State the thesis early; do not spend five paragraphs warming up.
3. **Body**
   - What changed / what the problem is.
   - Why it matters and the mechanism behind it.
   - Evidence or case.
   - A complete method or decision framework.
   - Counterpoint, limitation, or failure condition.
4. **Ending**
   - Compress the thesis.
   - Give a practical next action.
   - Ask one substantive question.

## Reading and layout

- Markdown-first semantic structure.
- H2 every 3–6 paragraphs.
- Short paragraphs, meaningful lists, tables for comparison, and highlighted callouts for conclusions.
- Code and commands must be copyable and tested/sourced.
- Images must explain, demonstrate, or provide evidence.
- Generate HTML with `content.wechat_layout`; keep styling secondary to readability.

## Evidence rules

- Link every important external claim to a source note.
- Separate observation, inference, and opinion.
- Never fabricate interviews, usage, screenshots, or “内部消息”.
- Timely hooks may attract the click; the article must still be useful after the trend passes.

## Required output

- content ID;
- one title;
- summary;
- Markdown article;
- HTML layout structure;
- cover brief (900×383);
- source notes;
- tags;
- draft metadata;
- unresolved facts and compliance risks.
