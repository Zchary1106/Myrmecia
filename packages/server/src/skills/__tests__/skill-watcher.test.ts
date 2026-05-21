import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillWatcher } from '../skill-watcher.js';

vi.mock('../../events/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('../../db/models/skill.js', () => ({
  checksumSkillContent: vi.fn((c: string) => `checksum_${c.length}`),
  getSkillVersionByChecksum: vi.fn(() => null),
  upsertSkill: vi.fn((d: any) => ({ id: d.id, name: d.name })),
  createSkillVersion: vi.fn((d: any) => ({ id: 'sv_1', skillId: d.skillId, version: 1 })),
  listSkillAssignments: vi.fn(() => []),
  assignSkillVersionToAgent: vi.fn(),
}));
vi.mock('../../db/models/notification.js', () => ({
  createNotification: vi.fn((d: any) => ({ id: 'notif_1', ...d })),
}));

import { getSkillVersionByChecksum } from '../../db/models/skill.js';

describe('SkillWatcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('syncFile skips when checksum matches existing version', () => {
    (getSkillVersionByChecksum as any).mockReturnValue({ id: 'sv_existing' });
    const watcher = new SkillWatcher('/fake/agents');
    const result = watcher.syncFile('test.md', '# Test Skill\nContent here');
    expect(result).toBe(false);
  });

  it('syncFile creates new version when checksum differs', () => {
    (getSkillVersionByChecksum as any).mockReturnValue(null);
    const watcher = new SkillWatcher('/fake/agents');
    const result = watcher.syncFile('test.md', '# Test Skill\nNew content');
    expect(result).toBe(true);
  });

  it('isIgnored returns true for paths in ignore set', () => {
    const watcher = new SkillWatcher('/fake/agents');
    watcher.addToIgnoreSet('/fake/agents/test.md');
    expect(watcher.isIgnored('/fake/agents/test.md')).toBe(true);
  });

  it('isIgnored returns false after expiry', async () => {
    const watcher = new SkillWatcher('/fake/agents');
    watcher.addToIgnoreSet('/fake/agents/test.md', 50);
    await new Promise(r => setTimeout(r, 100));
    expect(watcher.isIgnored('/fake/agents/test.md')).toBe(false);
  });
});
