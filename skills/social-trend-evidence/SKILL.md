---
name: social-trend-evidence
description: Research current Chinese social-content opportunities with auditable evidence from Douyin, public Xiaohongshu signals, web sources, and audience comments. Use for trend discovery, topic validation, competitor sampling, content-gap analysis, and deciding what to create next for Douyin, Xiaohongshu, or WeChat.
---

# Social Trend Evidence

Find **actionable content gaps**, not a list of broad hot words.

## Freshness contract

- Default window: last 7 days. Expand to 30 days only when the sample is too small.
- Evidence older than 7 days may support a durable pattern but cannot be labelled “current hot”.
- Record search time, query, sort, window, sample size, failures, and deduplication.
- Never treat one personalized feed or one creator as a platform-wide trend.

## Research sequence

1. **Frame the audience and job**
   - Define audience, pain, desired outcome, platform, and prohibited claims.
   - Generate 3–5 concrete query variants: problem, solution, beginner phrase, comparison, and avoid-pitfall phrase.

2. **Collect Douyin evidence**
   - Use `mcp__douyin-search__search_videos` for 2–3 distinct queries.
   - Prefer `publish_time=7`; compare `sort_type=1` (likes) with `sort_type=2` (newest) when needed.
   - Keep 5–10 deduplicated results per query. Capture title, author, date, likes, comments, shares, collects, duration, and source ID.
   - Inspect comments only for the top 1–2 candidates when audience questions are needed.

3. **Collect Xiaohongshu and WeChat signals**
   - Use `web.search` for public pages, search suggestions, recent articles, product/community discussions, and reputable industry reports.
   - Clearly label public-web evidence as incomplete; do not imply full platform access.
   - For WeChat, prioritize durable questions, explainers, case studies, policy/product changes, and topics that need more depth than a short post.

4. **Score opportunities within each query set**
   - **Utility**: saves/collects and “how do I do this?” comments.
   - **Transmission**: shares and “send this to…” behavior.
   - **Conversation**: comments containing disagreement, questions, or personal cases.
   - **Freshness**: recent publication with above-baseline interaction.
   - **Gap**: strong demand but weak, vague, outdated, or overcomplicated existing answers.
   - Use within-sample percentiles; never compare raw counts across unrelated categories as if audiences were equal.

5. **Classify the winning pattern**
   - Beginner full tutorial / “保姆级”
   - Checklist or reusable template
   - Tool/workflow teardown
   - Before-after transformation with proof
   - Avoid-pitfall / warning
   - Counterintuitive explanation
   - Timely event translated into practical action

## Decision rules

- Prefer high **collect/share intent** over empty high likes for tutorial content.
- A topic is not enough; produce a specific promise:
  - Weak: “AI tools”
  - Strong: “零基础把一篇资料变成可交付报告的完整流程”
- Do not clone titles, scripts, visual identity, or personal stories.
- Reject opportunities that depend on unverifiable income, health, financial, political, or exaggerated performance claims.

## Required output

Return:

1. research scope and limitations;
2. 5–10 evidence rows with source and raw metrics;
3. repeated audience questions;
4. pattern analysis;
5. three ranked opportunities with:
   - audience;
   - specific promise;
   - evidence;
   - novelty angle;
   - recommended platform form;
   - risk;
6. one recommended topic and one rejected topic with reasons;
7. platform-specific handoff:
   - Douyin Hook and video form;
   - Xiaohongshu search phrase and card story;
   - WeChat thesis and depth angle.
