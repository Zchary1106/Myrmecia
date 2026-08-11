import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/database.js';
import { createTask } from '../src/db/models/task.js';
import { listNotifications } from '../src/db/models/notification.js';
import { eventBus } from '../src/events/event-bus.js';
import { NotifierService } from '../src/notifications/notifier.js';

describe('NotifierService noise controls', () => {
  beforeAll(() => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'myrmecia-notifier-')), 'test.db');
    getDb();
    new NotifierService();
  });

  afterAll(() => {
    closeDb();
    delete process.env.DB_PATH;
  });

  it('does not notify for decomposition child completion', () => {
    const parent = createTask({ title: 'parent', description: 'parent', input: 'parent', mode: 'master' });
    const child = createTask({
      title: 'child',
      description: 'child',
      input: 'child',
      mode: 'master',
      parentTaskId: parent.id,
    });

    eventBus.emit('task:done', { taskId: child.id });

    expect(listNotifications()).toHaveLength(0);
  });

  it('keeps top-level completion and pipeline failure notifications', () => {
    const task = createTask({ title: 'standalone', description: 'task', input: 'task', mode: 'direct' });
    eventBus.emit('task:done', { taskId: task.id });
    eventBus.emit('pipeline:failed', { pipelineId: 'pipe_failed', error: 'media missing' });

    expect(listNotifications().map(notification => notification.title).sort()).toEqual([
      'Pipeline Failed',
      'Task Completed',
    ].sort());
  });
});
