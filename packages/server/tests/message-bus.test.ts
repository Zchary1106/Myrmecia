/**
 * AgentMessageBus — inter-agent mailbox: send, drain (consume-once),
 * pendingCount, and listForExecution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDb, getDb } from '../src/db/database.js';
import { AgentMessageBus } from '../src/agents/message-bus.js';

let bus: AgentMessageBus;

beforeEach(() => {
  closeDb();
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'agent-factory-msgbus-')), 'test.db');
  getDb();
  bus = new AgentMessageBus();
});

afterEach(() => {
  closeDb();
  delete process.env.DB_PATH;
});

describe('AgentMessageBus', () => {
  it('sends a message and reports it as pending for the recipient', () => {
    const msg = bus.send('exec-a', 'exec-b', 'text', 'hello');
    expect(msg.toExecution).toBe('exec-b');
    expect(msg.fromExecution).toBe('exec-a');
    expect(msg.consumed).toBe(false);
    expect(bus.pendingCount('exec-b')).toBe(1);
    expect(bus.pendingCount('exec-a')).toBe(0);
  });

  it('drains pending messages in order and consumes them once', () => {
    bus.send('exec-a', 'exec-b', 'text', 'first');
    bus.send('exec-a', 'exec-b', 'progress_update', 'second');

    const drained = bus.drain('exec-b');
    expect(drained.map(m => m.content)).toEqual(['first', 'second']);
    expect(drained.every(m => m.consumed)).toBe(true);

    // Consumed once — a second drain is empty.
    expect(bus.drain('exec-b')).toEqual([]);
    expect(bus.pendingCount('exec-b')).toBe(0);
  });

  it('isolates mailboxes per recipient', () => {
    bus.send('exec-a', 'exec-b', 'text', 'for b');
    bus.send('exec-a', 'exec-c', 'text', 'for c');
    expect(bus.drain('exec-b').map(m => m.content)).toEqual(['for b']);
    expect(bus.pendingCount('exec-c')).toBe(1);
  });

  it('lists messages an execution both sent and received', () => {
    bus.send('exec-a', 'exec-b', 'text', 'a→b');
    bus.send('exec-c', 'exec-a', 'text', 'c→a');
    const forA = bus.listForExecution('exec-a');
    expect(forA.map(m => m.content).sort()).toEqual(['a→b', 'c→a']);
  });

  it('supports a null sender', () => {
    const msg = bus.send(null, 'exec-b', 'text', 'system note');
    expect(msg.fromExecution).toBeUndefined();
    expect(bus.drain('exec-b')[0].content).toBe('system note');
  });
});
