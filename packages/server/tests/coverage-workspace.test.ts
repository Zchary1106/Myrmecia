import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTask } from '../src/db/models/task.js';
import { CoverageChecker } from '../src/workers/coverage-check.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('does not launch coverage for a non-Git execution nested inside a changed service repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'myrmecia-coverage-root-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, 'server.ts'), 'baseline'); git('add', 'server.ts'); git('commit', '-m', 'baseline');
  writeFileSync(join(root, 'server.ts'), 'changed service'); git('commit', '-am', 'changed service');
  const child = join(root, 'imported-project'); mkdirSync(child);
  const task = createTask({ title: 'Coverage directory boundary', description: '', input: '', mode: 'direct', workspacePath: child });
  expect(new CoverageChecker({ enabled: false }).shouldCheck(task.id)).toBe(false);
});
