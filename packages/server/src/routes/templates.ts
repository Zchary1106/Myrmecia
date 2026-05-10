import { Router } from 'express';
import { z } from 'zod';
import { listAgents } from '../db/models/agent.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { listTemplates, createTemplate, getTemplate, updateTemplate } from '../db/models/pipeline.js';
import { notFound, parseBody, requireOperatorRole, sendError } from './http.js';
import type { PipelineTemplateValidationResult } from '../types.js';

const templateStageSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  promptTemplate: z.string().trim().min(1),
});

const templateBodySchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  stages: z.array(templateStageSchema).min(1),
});

const updateTemplateSchema = templateBodySchema.partial()
  .refine(data => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

const validateTemplateBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  stages: z.array(z.object({
    name: z.string().optional(),
    role: z.string().optional(),
    promptTemplate: z.string().optional(),
  })).default([]),
});

function validateTemplateShape(data: { stages: { name?: string; role?: string; promptTemplate?: string }[] }): PipelineTemplateValidationResult {
  const errors: PipelineTemplateValidationResult['errors'] = [];
  const warnings: PipelineTemplateValidationResult['warnings'] = [];
  const agents = listAgents();
  const roles = new Set(agents.map(agent => agent.role));
  if (!data.stages.length) errors.push({ field: 'stages', message: 'Template must include at least one stage' });
  data.stages.forEach((stage, index) => {
    if (!stage.name?.trim()) errors.push({ stageIndex: index, field: 'name', message: 'Stage name is required' });
    if (!stage.role?.trim()) {
      errors.push({ stageIndex: index, field: 'role', message: 'Agent role is required' });
    } else if (!roles.has(stage.role)) {
      errors.push({ stageIndex: index, field: 'role', message: `No available Agent has role "${stage.role}"` });
    }
    if (!stage.promptTemplate?.trim()) {
      errors.push({ stageIndex: index, field: 'promptTemplate', message: 'Prompt template is required' });
    } else if (!stage.promptTemplate.includes('{input}')) {
      warnings.push({ stageIndex: index, field: 'promptTemplate', message: 'Prompt template does not include {input}' });
    }
  });
  return { valid: errors.length === 0, errors, warnings };
}

export function createTemplateRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(listTemplates());
  });

  router.get('/:id', (req, res) => {
    const tmpl = getTemplate(req.params.id);
    if (!tmpl) return res.status(404).json({ error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' } });
    res.json(tmpl);
  });

  router.post('/', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'template.create', ['admin', 'operator']);
      const { name, description, stages } = parseBody(templateBodySchema, req);
      const tmpl = createTemplate({ name, description, stages });
      createOperatorAction({
        action: 'template.create',
        actor,
        targetType: 'template',
        targetId: tmpl.id,
        metadata: { stages: tmpl.stages.length },
      });
      res.status(201).json(tmpl);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      const existing = getTemplate(req.params.id);
      if (!existing) notFound('TEMPLATE_NOT_FOUND', 'Template not found');
      const actor = requireOperatorRole(req, 'template.update', ['admin', 'operator']);
      const updated = updateTemplate(req.params.id, parseBody(updateTemplateSchema, req));
      if (!updated) notFound('TEMPLATE_NOT_FOUND', 'Template not found');
      createOperatorAction({
        action: 'template.update',
        actor,
        targetType: 'template',
        targetId: req.params.id,
        metadata: {
          previous: { name: existing.name, stages: existing.stages.length },
          next: { name: updated.name, stages: updated.stages.length },
        },
      });
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/validate', (req, res) => {
    try {
      const body = parseBody(validateTemplateBodySchema, req);
      res.json(validateTemplateShape({ stages: body.stages || [] }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/validate', (req, res) => {
    try {
      const tmpl = getTemplate(req.params.id);
      if (!tmpl) notFound('TEMPLATE_NOT_FOUND', 'Template not found');
      res.json(validateTemplateShape(tmpl));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
