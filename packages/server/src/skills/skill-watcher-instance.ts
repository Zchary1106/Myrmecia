import type { SkillWatcher } from './skill-watcher.js';

export let skillWatcher: SkillWatcher | null = null;

export function setSkillWatcher(watcher: SkillWatcher): void {
  skillWatcher = watcher;
}
