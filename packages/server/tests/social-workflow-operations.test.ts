import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { createAgent } from '../src/db/models/agent.js';
import { createTask } from '../src/db/models/task.js';
import {
  createSocialMonitorJobs,
  createSocialSchedule,
  findSocialScheduleConflicts,
  getActiveSocialComplianceRulebook,
  listSocialMonitorJobs,
  saveSocialComplianceRulebook,
} from '../src/db/models/social-workflow.js';
import { SocialMonitorWorker } from '../src/workers/social-monitor.js';
import type { AgentManager } from '../src/agents/agent-manager.js';
import type { TaskQueue } from '../src/queue/task-queue.js';

describe('social workflow operations', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'social-workflow-ops-')), 'test.db');
    getDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('persists schedules and detects account/time conflicts', () => {
    createSocialSchedule({
      workspaceId: 'workspace-a',
      contentId: 'content-a',
      platform: 'xiaohongshu',
      accountId: 'account-1',
      scheduleAt: '2026-08-05T10:00:00.000Z',
      status: 'scheduled',
    });

    const conflicts = findSocialScheduleConflicts({
      workspaceId: 'workspace-a',
      platform: 'xiaohongshu',
      accountId: 'account-1',
      scheduleAt: '2026-08-05T10:20:00.000Z',
      windowMinutes: 30,
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].contentId).toBe('content-a');
  });

  it('versions compliance rulebooks per workspace', () => {
    const first = saveSocialComplianceRulebook({
      workspaceId: 'workspace-a',
      yaml: 'version: 1\nrules:\n  - id: R1\n',
      createdBy: 'operator-a',
    });
    const second = saveSocialComplianceRulebook({
      workspaceId: 'workspace-a',
      yaml: 'version: 2\nrules:\n  - id: R2\n',
      createdBy: 'operator-b',
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(getActiveSocialComplianceRulebook('workspace-a')).toMatchObject({
      version: 2,
      createdBy: 'operator-b',
    });
  });

  it('persists monitor windows and dispatches due jobs', async () => {
    createSocialMonitorJobs({
      workspaceId: 'workspace-a',
      contentId: 'content-a',
      platform: 'douyin',
      publishId: 'publish-a',
      publishedAt: '2026-07-20T00:00:00.000Z',
    });
    const analytics = createAgent({
      id: 'analytics-agent',
      name: 'Analytics',
      role: 'social-analytics',
    });
    const enqueue = vi.fn(async (data: any) => createTask({
      title: data.title,
      description: data.description,
      input: data.input,
      mode: 'direct',
      assigneeId: data.assigneeId,
      workspaceId: data.workspaceId,
    }));
    const manager = {
      findAvailableAgent: (role: string) => role === 'social-analytics' ? analytics : undefined,
    } as unknown as AgentManager;
    const worker = new SocialMonitorWorker({ enqueue } as unknown as TaskQueue, manager);

    expect(await worker.runOnce(new Date('2026-08-04T00:00:00.000Z'))).toBe(3);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(listSocialMonitorJobs({ workspaceId: 'workspace-a', status: 'running' })).toHaveLength(3);
    worker.stop();
  });
});
