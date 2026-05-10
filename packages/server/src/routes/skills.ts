import { Router } from 'express';
import { z } from 'zod';
import { getAgent } from '../db/models/agent.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import {
  archiveSkillVersion,
  assignSkillVersionToAgent,
  createSkillVersion,
  getSkill,
  getSkillDetail,
  getSkillVersion,
  listSkillAssignments,
  listSkills,
  publishSkillVersion,
  updateDraftSkillVersion,
  upsertSkill,
} from '../db/models/skill.js';
import { eventBus } from '../events/event-bus.js';
import { HttpError, notFound, parseBody, requireOperatorRole, sendError } from './http.js';

const createSkillSchema = z.object({
  id: z.string().trim().min(1).regex(/^[a-zA-Z0-9_.:-]+$/).optional(),
  name: z.string().trim().min(1),
  description: z.string().optional(),
  sourcePath: z.string().trim().min(1).optional(),
});

const createVersionSchema = z.object({
  content: z.string().min(1),
  changelog: z.string().optional(),
  status: z.enum(['draft', 'published']).optional(),
});

const updateDraftSchema = z.object({
  content: z.string().min(1).optional(),
  changelog: z.string().optional(),
}).refine(data => Object.keys(data).length > 0, { message: 'At least one field must be provided' });

const assignmentSchema = z.object({
  skillVersionId: z.string().trim().min(1),
});

function skillIdFromName(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

export function createSkillRoutes(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listSkills());
  });

  router.post('/', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'skill.create', ['admin', 'operator']);
      const body = parseBody(createSkillSchema, req);
      const skill = upsertSkill({
        id: body.id || skillIdFromName(body.name),
        name: body.name,
        description: body.description,
        sourcePath: body.sourcePath,
      });
      createOperatorAction({
        action: 'skill.create',
        actor,
        targetType: 'skill',
        targetId: skill.id,
        metadata: { next: skill },
      });
      eventBus.emit('skill:updated', { skillId: skill.id, skill });
      res.status(201).json(skill);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/assignments', (_req, res) => {
    res.json(listSkillAssignments());
  });

  router.put('/assignments/:agentId', (req, res) => {
    try {
      const agent = getAgent(req.params.agentId);
      if (!agent) notFound('AGENT_NOT_FOUND', 'Agent not found');
      const actor = requireOperatorRole(req, 'skill.assignment.update', ['admin', 'operator']);
      const body = parseBody(assignmentSchema, req);
      const version = getSkillVersion(body.skillVersionId);
      if (!version) notFound('SKILL_VERSION_NOT_FOUND', 'Skill version not found');
      if (version.status !== 'published') {
        throw new HttpError(400, 'INVALID_SKILL_VERSION_STATUS', 'Only published skill versions can be assigned');
      }
      const assignment = assignSkillVersionToAgent(req.params.agentId, version.id);
      createOperatorAction({
        action: 'skill.assignment.update',
        actor,
        targetType: 'skill',
        targetId: version.skillId,
        metadata: { agentId: req.params.agentId, skillVersionId: version.id },
      });
      eventBus.emit('skill:assigned', { agentId: req.params.agentId, skillId: version.skillId, skillVersionId: version.id });
      res.json(assignment);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch('/versions/:versionId', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'skill.version.update', ['admin', 'operator']);
      const existing = getSkillVersion(req.params.versionId);
      if (!existing) notFound('SKILL_VERSION_NOT_FOUND', 'Skill version not found');
      const updated = updateDraftSkillVersion(req.params.versionId, parseBody(updateDraftSchema, req));
      if (!updated) notFound('SKILL_VERSION_NOT_FOUND', 'Skill version not found');
      createOperatorAction({
        action: 'skill.version.update',
        actor,
        targetType: 'skill',
        targetId: updated.skillId,
        metadata: {
          skillVersionId: updated.id,
          previousChecksum: existing.checksum,
          nextChecksum: updated.checksum,
        },
      });
      eventBus.emit('skill:updated', { skillId: updated.skillId, skillVersionId: updated.id });
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/versions/:versionId/publish', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'skill.version.publish', ['admin', 'operator']);
      const published = publishSkillVersion(req.params.versionId, actor.id);
      if (!published) notFound('SKILL_VERSION_NOT_FOUND', 'Skill version not found');
      createOperatorAction({
        action: 'skill.version.publish',
        actor,
        targetType: 'skill',
        targetId: published.skillId,
        metadata: { skillVersionId: published.id, checksum: published.checksum },
      });
      eventBus.emit('skill:published', { skillId: published.skillId, skillVersionId: published.id });
      res.json(published);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/versions/:versionId/archive', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'skill.version.archive', ['admin', 'operator']);
      const archived = archiveSkillVersion(req.params.versionId);
      if (!archived) notFound('SKILL_VERSION_NOT_FOUND', 'Skill version not found');
      createOperatorAction({
        action: 'skill.version.archive',
        actor,
        targetType: 'skill',
        targetId: archived.skillId,
        metadata: { skillVersionId: archived.id },
      });
      eventBus.emit('skill:updated', { skillId: archived.skillId, skillVersionId: archived.id });
      res.json(archived);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id', (req, res) => {
    const detail = getSkillDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: { code: 'SKILL_NOT_FOUND', message: 'Skill not found' } });
    res.json(detail);
  });

  router.post('/:id/versions', (req, res) => {
    try {
      const skill = getSkill(req.params.id);
      if (!skill) notFound('SKILL_NOT_FOUND', 'Skill not found');
      const actor = requireOperatorRole(req, 'skill.version.create', ['admin', 'operator']);
      const body = parseBody(createVersionSchema, req);
      const version = createSkillVersion({
        skillId: req.params.id,
        content: body.content,
        changelog: body.changelog,
        status: body.status || 'draft',
        createdBy: actor.id,
        publishedBy: body.status === 'published' ? actor.id : undefined,
      });
      createOperatorAction({
        action: 'skill.version.create',
        actor,
        targetType: 'skill',
        targetId: req.params.id,
        metadata: { skillVersionId: version.id, status: version.status, checksum: version.checksum },
      });
      eventBus.emit(version.status === 'published' ? 'skill:published' : 'skill:updated', {
        skillId: req.params.id,
        skillVersionId: version.id,
      });
      res.status(201).json(version);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
