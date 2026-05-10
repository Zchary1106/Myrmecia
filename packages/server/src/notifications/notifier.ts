import { eventBus } from '../events/event-bus.js';
import { createNotification } from '../db/models/notification.js';
import type { Notification } from '../types.js';

export class NotifierService {
  constructor() {
    this.setupListeners();
  }

  private setupListeners() {
    eventBus.on('task:done', (event) => {
      const { taskId } = event.payload as any;
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
      const notif = createNotification({
        type: 'task_failed',
        title: 'Task Failed',
        message: `Task ${taskId} failed: ${error}`,
        taskId,
      });
      eventBus.emit('notification', { notification: notif });
    });

    eventBus.on('pipeline:stage:done', (event) => {
      const { pipelineId, stageIndex } = event.payload as any;
      const notif = createNotification({
        type: 'pipeline_stage',
        title: 'Pipeline Stage Complete',
        message: `Pipeline ${pipelineId} stage ${stageIndex} completed`,
        pipelineId,
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
  }
}
