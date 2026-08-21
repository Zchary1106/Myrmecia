import { Router } from 'express';
import { z } from 'zod';
import {
  createSocialMonitorJobs,
  createSocialSchedule,
  findSocialScheduleConflicts,
  getSocialSchedule,
  listSocialMonitorJobs,
  listSocialSchedules,
  updateSocialScheduleStatus,
  getActiveSocialComplianceRulebook,
  saveSocialComplianceRulebook,
} from '../db/models/social-workflow.js';
import { workspaceIdFromRequest } from '../auth/tenant.js';
import { createOperatorAction } from '../db/models/operator-action.js';
import { parseBody, parseQuery, requireOperatorRole, sendError } from './http.js';
import { parse as parseYaml } from 'yaml';
import { researchPublicGitHubRepository } from '../github/github-repo-research.js';

const platformSchema = z.enum(['douyin', 'xiaohongshu', 'wechat']);
const scheduleStatusSchema = z.enum(['draft', 'scheduled', 'published', 'cancelled']);

const scheduleBodySchema = z.object({
  contentId: z.string().trim().min(1),
  platform: platformSchema,
  accountId: z.string().trim().min(1),
  scheduleAt: z.string().datetime(),
  status: scheduleStatusSchema.optional(),
});

const scheduleQuerySchema = z.object({
  platform: platformSchema.optional(),
  accountId: z.string().trim().min(1).optional(),
  status: scheduleStatusSchema.optional(),
});

const conflictQuerySchema = z.object({
  platform: platformSchema,
  accountId: z.string().trim().min(1),
  scheduleAt: z.string().datetime(),
  windowMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  excludeContentId: z.string().optional(),
});

const monitorBodySchema = z.object({
  contentId: z.string().trim().min(1),
  platform: platformSchema,
  publishId: z.string().trim().min(1),
  publishedAt: z.string().datetime(),
});

const monitorQuerySchema = z.object({
  platform: platformSchema.optional(),
  publishId: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
});

const githubRepoResearchSchema = z.object({
  repository: z.string().trim().min(3).max(500),
});

export function createSocialWorkflowRoutes(): Router {
  const router = Router();

  router.post('/github-repo-research', async (req, res) => {
    try {
      requireOperatorRole(req, 'social.github-repo-research', ['admin', 'operator']);
      const { repository } = parseBody(githubRepoResearchSchema, req);
      res.json(await researchPublicGitHubRepository(repository));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/schedules', (req, res) => {
    try {
      const query = parseQuery(scheduleQuerySchema, req);
      res.json(listSocialSchedules({ workspaceId: workspaceIdFromRequest(req), ...query }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/schedules/conflicts', (req, res) => {
    try {
      const query = parseQuery(conflictQuerySchema, req);
      const conflicts = findSocialScheduleConflicts({
        workspaceId: workspaceIdFromRequest(req),
        ...query,
      });
      res.json({ conflict: conflicts.length > 0, conflicts });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/schedules', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'social.schedule.create', ['admin', 'operator']);
      const body = parseBody(scheduleBodySchema, req);
      const schedule = createSocialSchedule({
        workspaceId: workspaceIdFromRequest(req),
        ...body,
      });
      createOperatorAction({
        action: 'social.schedule.create',
        actor,
        targetType: 'system',
        targetId: schedule.id,
        metadata: { contentId: schedule.contentId, platform: schedule.platform, scheduleAt: schedule.scheduleAt },
      });
      res.status(201).json(schedule);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/schedules/:id/status', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'social.schedule.update', ['admin', 'operator']);
      const { status } = parseBody(z.object({ status: scheduleStatusSchema }), req);
      const existing = getSocialSchedule(req.params.id);
      if (!existing || existing.workspaceId !== workspaceIdFromRequest(req)) {
        return res.status(404).json({ error: { code: 'SOCIAL_SCHEDULE_NOT_FOUND', message: 'Schedule not found' } });
      }
      const schedule = updateSocialScheduleStatus(req.params.id, status)!;
      createOperatorAction({
        action: 'social.schedule.update',
        actor,
        targetType: 'system',
        targetId: schedule.id,
        metadata: { status },
      });
      res.json(schedule);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/monitor-jobs', (req, res) => {
    try {
      const query = parseQuery(monitorQuerySchema, req);
      res.json(listSocialMonitorJobs({ workspaceId: workspaceIdFromRequest(req), ...query }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/monitor-jobs', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'social.monitor.create', ['admin', 'operator']);
      const body = parseBody(monitorBodySchema, req);
      const jobs = createSocialMonitorJobs({
        workspaceId: workspaceIdFromRequest(req),
        ...body,
      });
      createOperatorAction({
        action: 'social.monitor.create',
        actor,
        targetType: 'system',
        targetId: body.publishId,
        metadata: { contentId: body.contentId, platform: body.platform, windows: [48, 72, 168] },
      });
      res.status(201).json(jobs);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/compliance-rules', (req, res) => {
    try {
      const rulebook = getActiveSocialComplianceRulebook(workspaceIdFromRequest(req));
      res.json(rulebook
        ? { ...rulebook, parsed: parseYaml(rulebook.yaml) }
        : { version: 0, parsed: null });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/compliance-rules', (req, res) => {
    try {
      const actor = requireOperatorRole(req, 'social.compliance-rules.update', ['admin', 'operator']);
      const { yaml } = parseBody(z.object({ yaml: z.string().min(1).max(200_000) }), req);
      const parsed = parseYaml(yaml) as any;
      if (!parsed || !Array.isArray(parsed.rules) || parsed.rules.length === 0) {
        return res.status(400).json({
          error: { code: 'INVALID_SOCIAL_RULEBOOK', message: 'Rulebook must contain a non-empty rules array' },
        });
      }
      const ids = parsed.rules.map((rule: any) => rule?.id).filter(Boolean);
      if (ids.length !== parsed.rules.length || new Set(ids).size !== ids.length) {
        return res.status(400).json({
          error: { code: 'INVALID_SOCIAL_RULEBOOK', message: 'Every rule must have a unique id' },
        });
      }
      const rulebook = saveSocialComplianceRulebook({
        workspaceId: workspaceIdFromRequest(req),
        yaml,
        createdBy: actor.id,
      });
      createOperatorAction({
        action: 'social.compliance-rules.update',
        actor,
        targetType: 'system',
        targetId: rulebook.id,
        metadata: { version: rulebook.version, ruleCount: parsed.rules.length },
      });
      res.json({ ...rulebook, parsed });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
