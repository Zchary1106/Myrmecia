import OpenAI from 'openai';
import { listSkills, getLatestPublishedSkillVersion } from '../db/models/skill.js';
import { parseSkillContent } from './skill-parser.js';
import { logger } from '../lib/logger.js';
import type { SkillExecutorConfig } from '../types.js';

export interface SkillCandidate {
  id: string;
  name: string;
  description?: string;
  trigger?: SkillExecutorConfig['trigger'];
}

export interface MatchResult {
  skillId: string | null;
  confidence: number;
  reason?: string;
}

export function buildMatcherPrompt(taskInput: string, skills: SkillCandidate[]): string {
  const skillList = skills.map((s, i) =>
    `${i + 1}. ID: "${s.id}" | Name: "${s.name}" | Description: ${s.description || 'N/A'} | Keywords: ${s.trigger?.keywords?.join(', ') || 'N/A'} | Roles: ${s.trigger?.agentRoles?.join(', ') || 'any'}`
  ).join('\n');

  return `You are a skill matcher. Given a task description and available skills, select the BEST matching skill.

## Available Skills:
${skillList}

## Task:
${taskInput}

## Instructions:
- If a skill clearly matches the task, return its ID with high confidence.
- If no skill is a good fit, return "none".
- Respond with ONLY valid JSON: {"skillId": "<id or none>", "confidence": <0.0-1.0>, "reason": "<brief reason>"}`;
}

export function parseMatcherResponse(response: string): MatchResult {
  try {
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return { skillId: null, confidence: 0 };

    const parsed = JSON.parse(jsonMatch[0]);
    const skillId = parsed.skillId === 'none' ? null : (parsed.skillId || null);
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    return { skillId, confidence, reason: parsed.reason };
  } catch {
    return { skillId: null, confidence: 0 };
  }
}

export async function matchSkillForTask(
  taskInput: string,
  agentRole?: string,
): Promise<MatchResult> {
  const allSkills = listSkills();
  const candidates: SkillCandidate[] = [];

  for (const skill of allSkills) {
    const version = getLatestPublishedSkillVersion(skill.id);
    if (!version) continue;
    const parsed = parseSkillContent(version.content);
    if (!parsed.isStructured) continue;

    const trigger = parsed.config!.trigger;
    if (trigger?.agentRoles && agentRole && !trigger.agentRoles.includes(agentRole)) {
      continue;
    }

    candidates.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      trigger,
    });
  }

  if (candidates.length === 0) {
    return { skillId: null, confidence: 0, reason: 'No structured skills available' };
  }

  try {
    const client = new OpenAI({
      baseURL: process.env.CREWAI_BASE_URL || 'https://your-model-endpoint.example.com/v1',
      apiKey: process.env.CREWAI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    });

    const prompt = buildMatcherPrompt(taskInput, candidates);
    const response = await client.chat.completions.create({
      model: process.env.CREWAI_MODEL || 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content || '';
    return parseMatcherResponse(content);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Skill matcher LLM call failed');
    return { skillId: null, confidence: 0, reason: `LLM error: ${err.message}` };
  }
}
