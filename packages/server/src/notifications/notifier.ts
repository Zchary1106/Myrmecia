import { eventBus } from '../events/event-bus.js';
import { createNotification } from '../db/models/notification.js';
import { getTask } from '../db/models/task.js';
import type { Notification } from '../types.js';

export class NotifierService {
  constructor() {
    this.setupListeners();
  }

  private setupListeners() {
    eventBus.on('task:done', (event) => {
      const { taskId } = event.payload as any;
      const task = getTask(taskId);
      if (task?.pipelineId || task?.parentTaskId) return;
      const notif = createNotification({
        type: 'task_complete',
        title: 'Task Completed',
        message: `Task ${taskId} completed successfully`,
        taskId,
      });
      eventBus.emit('notification', { notification: notif });
    });

    eventBus.on('task:failed', (event) => {
      const { taskId, error } = event.payload as any;
      const task = getTask(taskId);
      if (task?.pipelineId || task?.parentTaskId) return;
      const notif = createNotification({
        type: 'task_failed',
        title: 'Task Failed',
        message: `Task ${taskId} failed: ${error}`,
        taskId,
      });
      eventBus.emit('notification', { notification: notif });
    });

    eventBus.on('pipeline:done', (event) => {
      const { pipelineId } = event.payload as any;
      const notif = createNotification({
        type: 'pipeline_stage',
        title: 'Pipeline Complete',
        message: `Pipeline ${pipelineId} has finished all stages`,
        pipelineId,
      });
      eventBus.emit('notification', { notification: notif });
    });

    eventBus.on('pipeline:failed', (event) => {
      const { pipelineId, error } = event.payload as any;
      const notif = createNotification({
        type: 'task_failed',
        title: 'Pipeline Failed',
        message: `Pipeline ${pipelineId} failed: ${error || 'operator attention required'}`,
        pipelineId,
      });
      eventBus.emit('notification', { notification: notif });
    });
  }
}
