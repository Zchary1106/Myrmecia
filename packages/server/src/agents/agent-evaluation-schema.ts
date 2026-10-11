import { z } from 'zod';
import { completionCriteriaSchema } from './completion-gate.js';

const id = z.string().regex(/^[a-zA-Z0-9._:-]{1,80}$/);
const evaluationSuiteObject = z.object({
  name: z.string().trim().min(1).max(120),
  cases: z.array(z.object({
    id, name: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(8000),
    checks: completionCriteriaSchema.refine(checks => checks.length > 0 && checks.some(check => check.required),
      'At least one required check is needed; empty checks cannot imply a pass'),
  }).strict()).min(1).max(20).refine(cases => new Set(cases.map(item => item.id)).size === cases.length, 'Case IDs must be unique'),
}).strict();
const boundedSuite = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= 128_000;
export const evaluationSuiteSchema = evaluationSuiteObject.refine(boundedSuite, 'Suite exceeds 128 KB');
export const evaluationSaveSchema = evaluationSuiteObject.extend({
  expectedRevision: z.number().int().min(0),
}).strict().refine(boundedSuite, 'Suite exceeds 128 KB');
export const evaluationStartSchema = z.object({
  selectedCaseIds: z.array(id).min(1).max(20).refine(ids => new Set(ids).size === ids.length, 'Duplicate case IDs'),
  expectedSuiteRevision: z.number().int().min(1),
  configVersionId: z.string().min(1).max(100),
}).strict();
export const evaluationNextSchema = z.object({ caseId: id }).strict();
