---
name: xiaohongshu-save-first-writer
description: Create search-first, saveable Xiaohongshu notes and 3:4 card briefs from verified evidence. Use for tutorials, checklists, tool comparisons, workflow teardowns, study notes, and practical experience content without fabricating personal use.
---

# Xiaohongshu Save-first Writer

Write for a reader who arrives with a question and wants an answer worth saving.

## Research-only requests

When the user asks for research, comparisons or a follow-up answer rather than a publishable note, return a concise answer with sources and limitations. Do not generate cards, hashtags or publish content.
For Xiaohongshu evidence, use the authorized read-only MCP tools: check_login_status, then search_feeds, then get_feed_detail with the returned note_ref. Never request or expose xsec tokens. Limit each turn to two searches and two note details. Stop after a login failure or timeout and state that site evidence is missing; public web results are not Xiaohongshu MCP evidence.

## Select one note mode

- Step-by-step tutorial
- Checklist/template
- Comparison or decision guide
- Workflow/tool teardown
- Mistakes and avoid-pitfall guide
- Evidence-backed reflection

Do not mix several modes in one note.

## Search-first workflow

1. Extract the likely search phrase and user situation.
2. Make one promise that can be delivered by the body and cards.
3. Write one final title:
   - maximum 20 characters/words per platform limit;
   - include the concrete object/result;
   - no fake “亲测”, identity, income, or transformation.
4. Structure the body:
   - who this is for;
   - result first;
   - 3–7 actionable points;
   - example/proof;
   - limitation;
   - one natural interaction question.
5. Build a 6–8 card story:
   - cover;
   - problem/context;
   - 3–5 point/list cards;
   - example or warning;
   - ending/checklist.

## Visual-copy rules

- One conclusion per card.
- Cover: short outcome + target audience or constraint.
- Body card: heading ≤16 Chinese characters; body usually ≤60 characters.
- Use emphasis sparingly.
- Prefer diagrams, steps, tables, and before/after evidence over decorative images.
- Keep themes consistent and preview the complete set before publishing.

## Quality gate

- Title, body, tags, and cards express the same promise.
- Claims come from the approved content core.
- No alternative titles remain.
- No copied creator voice or fabricated personal story.
- Tags combine object, problem, audience, and format; avoid unrelated traffic tags.

## Required output — publishable notes only

This template does not apply to research-only requests. For research or advice, use a direct answer, sourced comparison, explicitly stated assumptions and unknowns. Missing evidence is not permission to invent historical prices or confident rankings.

- content ID;
- note mode and search intent;
- one title;
- body ≤1000 Chinese characters;
- 6–8 ordered card briefs;
- tags and CTA;
- source/unknown notes;
- recommended visual theme.
