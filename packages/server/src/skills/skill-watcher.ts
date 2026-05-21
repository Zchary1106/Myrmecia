import { watch, readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { eventBus } from '../events/event-bus.js';
import {
  checksumSkillContent,
  getSkillVersionByChecksum,
  upsertSkill,
  createSkillVersion,
  listSkillAssignments,
  assignSkillVersionToAgent,
} from '../db/models/skill.js';
import { createNotification } from '../db/models/notification.js';
import { logger } from '../lib/logger.js';

export class SkillWatcher {
  private watchDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private ignoreSet = new Map<string, number>();
  private debounceMs = 500;

  constructor(watchDir: string) {
    this.watchDir = watchDir;
  }

  start(): void {
    if (!existsSync(this.watchDir)) {
      logger.warn({ dir: this.watchDir }, 'Skill watch directory does not exist');
      return;
    }

    this.watcher = watch(this.watchDir, (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;

      const fullPath = join(this.watchDir, filename);
      if (this.isIgnored(fullPath)) return;

      const existing = this.debounceTimers.get(filename);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(filename, setTimeout(() => {
        this.debounceTimers.delete(filename);
        this.handleFileChange(filename);
      }, this.debounceMs));
    });

    logger.info({ dir: this.watchDir }, 'Skill watcher started');
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    logger.info('Skill watcher stopped');
  }

  addToIgnoreSet(fullPath: string, durationMs: number = 2000): void {
    this.ignoreSet.set(fullPath, Date.now() + durationMs);
  }

  isIgnored(fullPath: string): boolean {
    const expiry = this.ignoreSet.get(fullPath);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.ignoreSet.delete(fullPath);
      return false;
    }
    return true;
  }

  syncFile(filename: string, content: string): boolean {
    const id = basename(filename, '.md');
    const sourcePath = `agents/${filename}`;

    const titleMatch = content.match(/^#\s+(.+)/m);
    const name = titleMatch ? titleMatch[1].trim() : id;

    const skill = upsertSkill({ id, name, description: `Imported from ${sourcePath}`, sourcePath });
    const checksum = checksumSkillContent(content);
    const existing = getSkillVersionByChecksum(skill.id, checksum);

    if (existing) return false;

    const version = createSkillVersion({
      skillId: skill.id,
      content,
      status: 'published',
      changelog: 'Hot-reloaded from file change',
      createdBy: 'system',
      publishedBy: 'system',
    });

    const assignments = listSkillAssignments({ skillId: skill.id });
    for (const a of assignments) {
      assignSkillVersionToAgent(a.agentId, version.id);
    }

    eventBus.emit('skill:updated', { skillId: skill.id, skillVersionId: version.id, source: 'file' });

    createNotification({
      type: 'task_complete' as any,
      title: 'Skill Updated',
      message: `Skill "${name}" hot-reloaded from file change`,
    });

    logger.info({ skillId: skill.id, version: version.version }, `Skill hot-reloaded: ${name}`);
    return true;
  }

  private handleFileChange(filename: string): void {
    const fullPath = join(this.watchDir, filename);
    if (!existsSync(fullPath)) return;

    try {
      const content = readFileSync(fullPath, 'utf-8');
      this.syncFile(filename, content);
    } catch (err: any) {
      logger.warn({ filename, error: err.message }, 'Failed to hot-reload skill');
    }
  }
}
