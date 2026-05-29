import { Router } from 'express';
import { getExecutionAuditReport, listExecutionAuditReports } from '../audit/execution-audit.js';
import { requestCanAccessWorkspace } from '../auth/tenant.js';

export function createExecutionAuditRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (workspaceId && !requestCanAccessWorkspace(req, workspaceId)) {
      return res.status(403).json({ error: { code: 'WORKSPACE_FORBIDDEN', message: 'Workspace access denied' } });
    }
    const reports = listExecutionAuditReports({
      taskId: req.query.taskId as string | undefined,
      workspaceId,
      limit: req.query.limit ? Number(req.query.limit) : 50,
    }).filter(report => requestCanAccessWorkspace(req, report.workspaceId));
    res.json({ reports });
  });

  router.get('/:executionId', (req, res) => {
    const report = getExecutionAuditReport(req.params.executionId);
    if (!report) {
      return res.status(404).json({ error: { code: 'AUDIT_NOT_FOUND', message: 'Execution audit report not found' } });
    }
    if (!requestCanAccessWorkspace(req, report.workspaceId)) {
      return res.status(403).json({ error: { code: 'WORKSPACE_FORBIDDEN', message: 'Workspace access denied' } });
    }
    res.json(report);
  });

  return router;
}
