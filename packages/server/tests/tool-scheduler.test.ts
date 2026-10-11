import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyToolEffect, scheduleToolBatch, type ToolClassification } from '../src/agents/core/tool-scheduler.js';
import { classifyRuntimeTool } from '../src/agents/tool-dispatch-policy.js';
const calls = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `${i}`, name: 'read', arguments: '{}' }));
const read = (): ToolClassification => ({ effect: 'read', resources: [], basis: 'trusted fixture' });
afterEach(() => vi.useRealTimers());
describe('safe bounded tool scheduler', () => {
  it('uses two 100ms read waves with a fake clock, bounded activity and model-order outputs', async () => {
    vi.useFakeTimers();
    let active = 0; let max = 0;
    const start = Date.now();
    const batch = scheduleToolBatch(calls(4), { signal: new AbortController().signal, readConcurrency: 2, classify: read,
      execute: async call => {
        active++; max = Math.max(max, active);
        await new Promise(resolve => setTimeout(resolve, 100));
        active--; return call.id;
      } });
    await vi.runAllTimersAsync();
    expect(await batch).toEqual(['0', '1', '2', '3']);
    expect(Date.now() - start).toBe(200);
    expect(max).toBe(2);
  });
  it('drains reads before a write or dynamically upgraded unknown call and does not launch its successor early', async () => {
    let active = 0;
    const order: string[] = [];
    await scheduleToolBatch(calls(4), { signal: new AbortController().signal, readConcurrency: 4, classify: read,
      recheck: call => call.id === '2' ? { ...read(), effect: 'write', basis: 'upgraded' } : read(),
      execute: async (call, classified) => {
        if (classified.effect !== 'read') expect(active).toBe(0);
        active++; order.push(`start${call.id}`);
        await Promise.resolve();
        order.push(`done${call.id}`); active--; return call.id;
      } });
    expect(order.indexOf('start2')).toBeGreaterThan(order.indexOf('done1'));
    expect(order.indexOf('start3')).toBeGreaterThan(order.indexOf('done2'));
  });
  it.each(['resource', 'server'])('serializes conflicting %s reads', async kind => {
    let active = 0;
    await scheduleToolBatch(calls(3), { signal: new AbortController().signal, readConcurrency: 4,
      classify: () => ({ ...read(), resources: kind === 'resource' ? ['path:shared'] : [],
        serverKey: kind === 'server' ? 'mcp' : undefined }),
      execute: async call => { expect(active).toBe(0); active++; await Promise.resolve(); active--; return call.id; } });
  });
  it('atomically reserves quota before dispatch and waits for an already-started call on failure', async () => {
    let quota = 1; let finished = false;
    const invoked: string[] = [];
    await expect(scheduleToolBatch(calls(3), { signal: new AbortController().signal, readConcurrency: 2, classify: read,
      reserve: () => { if (--quota < 0) throw new Error('QUOTA_EXHAUSTED'); },
      execute: async call => { invoked.push(call.id); await Promise.resolve(); finished = true; return call.id; },
    })).rejects.toThrow('QUOTA_EXHAUSTED');
    expect(invoked).toEqual(['0']);
    expect(finished).toBe(true);
  });
  it('stops new dispatch after cancellation, without replaying the active outcome', async () => {
    const controller = new AbortController();
    const invoked: string[] = [];
    await expect(scheduleToolBatch(calls(3), { signal: controller.signal, readConcurrency: 1, classify: read,
      execute: async call => { invoked.push(call.id); controller.abort(); return 'unconfirmed'; } })).rejects.toThrow('aborted');
    expect(invoked).toEqual(['0']);
  });
  it('cannot enable concurrency using untrusted metadata or arbitrary shell/MCP commands', () => {
    expect(classifyToolEffect({ trusted: false, readOnly: true })).toBe('unknown');
    expect(classifyToolEffect({ trusted: true, readOnly: true, destructive: true })).toBe('write');
    expect(classifyRuntimeTool({ id: 'a', name: 'file_read', arguments: '{"path":"a"}' }, '/tmp/w')).toMatchObject({ effect: 'read', resources: ['path:/tmp/w/a'] });
    expect(classifyRuntimeTool({ id: 'a', name: 'file_write', arguments: '{"path":"a"}' }, '/tmp/w').effect).toBe('write');
    expect(classifyRuntimeTool({ id: 'a', name: 'shell', arguments: '{"command":"cat a"}' }, '/tmp/w').effect).toBe('unknown');
    expect(classifyRuntimeTool({ id: 'a', name: 'mcp__xiaohongshu__search_feeds', arguments: '{}' }, '/tmp/w')).toMatchObject({ effect: 'read', serverKey: 'xiaohongshu', serverConcurrency: 1 });
    expect(classifyRuntimeTool({ id: 'a', name: 'mcp__untrusted__search', arguments: '{}' }, '/tmp/w')).toMatchObject({ effect: 'unknown', serverKey: 'untrusted' });
  });
  it('rejects duplicate IDs and invalid concurrency before executing anything', async () => {
    const execute = vi.fn();
    await expect(scheduleToolBatch([calls(1)[0], calls(1)[0]], { signal: new AbortController().signal, classify: read, execute })).rejects.toThrow('DUPLICATE');
    await expect(scheduleToolBatch(calls(1), { signal: new AbortController().signal, readConcurrency: 5, classify: read, execute })).rejects.toThrow('CONCURRENCY');
    expect(execute).not.toHaveBeenCalled();
  });
});
