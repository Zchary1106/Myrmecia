import { describe, it, expect } from 'vitest';
import { evaluateParentOutcome } from '../src/agents/master-agent.js';
import type { Task } from '@myrmecia/shared';

type Sub = Pick<Task, 'title' | 'status' | 'output'>;

const sub = (title: string, status: Task['status'], output = ''): Sub => ({ title, status, output });

describe('evaluateParentOutcome', () => {
  it('returns null while any subtask is still non-terminal', () => {
    expect(evaluateParentOutcome([sub('a', 'done'), sub('b', 'running')])).toBeNull();
    expect(evaluateParentOutcome([sub('a', 'pending')])).toBeNull();
    expect(evaluateParentOutcome([sub('a', 'assigned'), sub('b', 'queued')])).toBeNull();
  });

  it('returns null for an empty subtask list (not decomposed yet)', () => {
    expect(evaluateParentOutcome([])).toBeNull();
  });

  it('settles as done when every subtask is done', () => {
    const outcome = evaluateParentOutcome([sub('a', 'done', 'A out'), sub('b', 'done', 'B out')]);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe('done');
    expect(outcome!.logLevel).toBe('info');
    expect(outcome!.output).toContain('A out');
    expect(outcome!.output).toContain('B out');
  });

  it('settles as failed (not stuck) when a subtask fails — the hang regression', () => {
    const outcome = evaluateParentOutcome([sub('a', 'done'), sub('b', 'failed')]);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe('failed');
    expect(outcome!.logLevel).toBe('warn');
    expect(outcome!.message).toContain('1 failed: b');
  });

  it('settles as failed when a subtask is cancelled', () => {
    const outcome = evaluateParentOutcome([sub('a', 'done'), sub('b', 'cancelled')]);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe('failed');
    expect(outcome!.message).toContain('1 cancelled: b');
  });

  it('still consolidates deliverables even on partial failure', () => {
    const outcome = evaluateParentOutcome([
      sub('spec', 'done', 'the spec'),
      sub('code', 'failed', 'partial code'),
    ]);
    expect(outcome!.status).toBe('failed');
    expect(outcome!.output).toContain('the spec');
    expect(outcome!.output).toContain('partial code');
  });

  it('reports both failed and cancelled counts', () => {
    const outcome = evaluateParentOutcome([
      sub('a', 'failed'),
      sub('b', 'cancelled'),
      sub('c', 'done'),
    ]);
    expect(outcome!.status).toBe('failed');
    expect(outcome!.message).toContain('1 failed: a');
    expect(outcome!.message).toContain('1 cancelled: b');
  });
});
