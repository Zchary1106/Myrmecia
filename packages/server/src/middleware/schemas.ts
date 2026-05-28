/**
 * Zod validation schemas for core API request bodies.
 */

import { z } from 'zod';

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional().default(''),
  mode: z.enum(['master', 'direct', 'pipeline']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assigneeId: z.string().optional(),
  input: z.string().optional().default(''),
  workdir: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

export const updateTaskSchema = z.object({
  status: z.enum(['pending', 'queued', 'assigned', 'running', 'review', 'done', 'failed', 'cancelled']).optional(),
  assigneeId: z.string().nullable().optional(),
  output: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

export const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(50),
  emoji: z.string().max(4).optional(),
  description: z.string().max(1000).optional(),
  whenToUse: z.string().optional(),
  skillPath: z.string().optional(),
  config: z.object({
    maxConcurrent: z.number().int().optional(),
    timeout: z.number().int().optional(),
    workdir: z.string().optional(),
    maxTurns: z.number().int().optional(),
  }).optional(),
  capabilities: z.array(z.string()).optional(),
  triggers: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().optional(),
});

export const createPipelineSchema = z.object({
  name: z.string().min(1).max(200),
  templateId: z.string().min(1),
  input: z.string().min(1),
  gateMode: z.enum(['auto', 'manual']).optional(),
});

export const executeAgentSchema = z.object({
  prompt: z.string().min(1).max(50000),
  workdir: z.string().optional(),
  parentExecutionId: z.string().optional(),
});
