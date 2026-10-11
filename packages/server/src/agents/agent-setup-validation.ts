import { z } from 'zod';
import { artifactDeclarationSchema, artifactRequirementSchema } from '../contracts/team-composer-contracts.js';
import { scanForPII } from '../security/dlp.js';

const text = z.string().max(20_000);
const lines = z.array(z.string().trim().min(1).max(2000)).max(100);
export const setupFormSchema = z.object({
  name: z.string().max(200), role: z.string().max(200), emoji: z.string().max(32),
  description: text, whenToUse: text, systemInstructions: text,
  capabilities: text, triggers: text, allowedTools: lines, model: z.string().max(200),
  skillVersionId: z.string().max(200), testPrompt: z.string().max(8000),
  maxTurns: z.number().int().min(1).max(200),
  timeout: z.number().int().min(10).max(3600),
  maxConcurrent: z.number().int().min(1).max(8),
  contractEnabled: z.boolean(), owns: lines, doesNotOwn: lines, escalatesTo: lines,
  definitionOfDone: lines, inputs: z.array(artifactRequirementSchema).max(20),
  outputs: z.array(artifactDeclarationSchema).max(20),
}).strict().superRefine((form, ctx) => {
  const content = JSON.stringify(form);
  if (scanForPII(content).violations.some(violation => ['api_key', 'aws_key', 'private_key'].includes(violation.type))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '草稿不能保存密钥或凭证；请使用服务端凭证配置' });
  }
});
export const saveDraftSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  form: setupFormSchema, step: z.number().int().min(0).max(3),
  locked: z.boolean(), testSubmitted: z.boolean(),
}).strict();
