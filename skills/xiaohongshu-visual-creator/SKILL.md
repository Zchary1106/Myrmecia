---
name: xiaohongshu-visual-creator
description: Create publish-ready Xiaohongshu/RedNote 3:4 visual card sets from an approved final draft. Use for visual concept selection, card-story sequencing, copy compression, image.generate_cards rendering, optional ComfyUI illustrations, media inspection, and visual QA before publishing.
---

# Xiaohongshu Visual Creator

Turn an approved final draft into a coherent, readable 6–8 card visual story. Do not rewrite facts or perform publishing.

Read `references/visual-system.md` before planning cards.

## Workflow

1. **Lock the source**
   - Require a unique approved title, body, and verified human approval record.
   - Stop if the source still contains alternatives, unresolved findings, or unverified claims.

2. **Choose one visual concept**
   - Select one theme from `tech`, `editorial`, `notebook`, `warm`, `clean`, or `dark`.
   - State the audience, desired feeling, visual hierarchy, and reason for the theme.
   - Use `tech` by default for AI/programming tutorials.

3. **Build the card story**
   - Use exactly one `cover`, 4–6 `point`/`list` cards, and one `end`.
   - Make every card understandable without reading the original article.
   - Keep one conclusion per card and follow the text budgets in the reference.

4. **Prepare the render specification**
   - Copy only facts and recommendations from the approved draft.
   - Use `**…**` for at most two emphasis spans per card.
   - Do not place URLs, private-contact prompts, citations, or long paragraphs on cards.

5. **Render**
   - Call `image.generate_cards` once with the complete ordered card array.
   - Use `image.generate_comfyui` only for 1–2 optional text-free illustrations when they materially improve the story.
   - Never substitute an SVG, sample path, or textual card plan for real PNG output.

6. **Inspect**
   - Call `media.inspect` for every returned file.
   - Verify existence, PNG/JPEG format, 1080×1440 dimensions, readable order, and metadata warnings.
   - If QA fails, revise the specification and render once more. Do not loop indefinitely.

7. **Return structured output**

Return only:

```json
{
  "schema_version": "1.0",
  "status": "generated",
  "theme": "tech",
  "concept": "one sentence",
  "paths": ["/absolute/card-01.png"],
  "count": 7,
  "qa": {
    "status": "pass",
    "checked_paths": ["/absolute/card-01.png"],
    "warnings": []
  }
}
```

The `paths` array must contain every real image in publication order.
