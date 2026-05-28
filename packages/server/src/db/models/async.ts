/**
 * Async model barrel — re-exports async versions of all models.
 * Import from here in route handlers for production-grade async DB access.
 *
 * Usage:
 *   import { createTaskAsync, listTasksAsync } from '../db/models/async.js';
 */

export { createTaskAsync, getTaskAsync, listTasksAsync, updateTaskAsync, deleteTaskAsync, addTaskLogAsync, getTaskLogsAsync } from './task-async.js';

// Sync models are still available for backward compat (agent-runtime, etc.)
// Gradually migrate callers to async versions.
