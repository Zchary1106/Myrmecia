import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb } from '../src/db/database.js';
import {
  createExternalAgent,
  createExternalAgentRun,
  createExternalAgentSchedule,
  getExternalAgent,
  listExternalAgentRuns,
  listExternalAgentSchedules,
  updateExternalAgent,
} from '../src/db/models/external-agent.js';

describe('external Agent persistence', () => {
  beforeEach(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-external-agent-')), 'test.db');
  });

  afterEach(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('keeps external Agents, runs, and schedules inside their workspace', () => {
    const agent = createExternalAgent({
      workspaceId: 'workspace-a',
      name: 'Codex engineering',
      adapter: { kind: 'local_cli', profile: 'codex' },
      capabilities: ['coding'],
    });
    createExternalAgent({
      workspaceId: 'workspace-b',
      name: 'HTTP research',
      adapter: { kind: 'http', endpoint: 'https://agents.example.test/run' },
    });

    expect(getExternalAgent(agent.id, 'workspace-a')?.adapter.kind).toBe('local_cli');
    expect(getExternalAgent(agent.id, 'workspace-b')).toBeUndefined();
    expect(updateExternalAgent(agent.id, 'workspace-a', { status: 'active' })?.status).toBe('active');

    const run = createExternalAgentRun({
      externalAgentId: agent.id,
      workspaceId: 'workspace-a',
      triggerType: 'manual',
      status: 'queued',
      invocation: { objective: 'Inspect the dashboard', constraints: ['Do not publish'] },
      artifactIds: [],
    });
    expect(listExternalAgentRuns({ workspaceId: 'workspace-a' })).toEqual([expect.objectContaining({ id: run.id })]);
    expect(listExternalAgentRuns({ workspaceId: 'workspace-b' })).toEqual([]);

    const schedule = createExternalAgentSchedule({
      externalAgentId: agent.id,
      workspaceId: 'workspace-a',
      triggerType: 'cron',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      invocation: { objective: 'Run weekday engineering review', constraints: [] },
      enabled: true,
    });
    expect(listExternalAgentSchedules({ workspaceId: 'workspace-a' })).toEqual([expect.objectContaining({ id: schedule.id })]);
    expect(listExternalAgentSchedules({ workspaceId: 'workspace-b' })).toEqual([]);
  });
});
