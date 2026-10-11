import type { RuntimeToolCall } from '@myrmecia/shared';

export type ToolEffect = 'read' | 'write' | 'unknown';
export interface ToolClassification {
  effect: ToolEffect;
  resources: string[];
  /** A single MCP connection is serialized unless trusted server policy says otherwise. */
  serverKey?: string;
  serverConcurrency?: number;
  basis: string;
}
export interface ToolSchedulerOptions {
  signal: AbortSignal;
  readConcurrency?: number;
  classify: (call: RuntimeToolCall) => ToolClassification;
  /** Recheck permission and effect immediately before dispatch. Only restrictions may be added. */
  recheck?: (call: RuntimeToolCall, classified: ToolClassification) => ToolClassification | Promise<ToolClassification>;
  reserve?: (call: RuntimeToolCall, classified: ToolClassification) => void | Promise<void>;
  execute: (call: RuntimeToolCall, classified: ToolClassification) => Promise<string>;
  onDispatch?: (call: RuntimeToolCall, classified: ToolClassification) => void;
}

export function classifyToolEffect(metadata?: { trusted: boolean; readOnly?: boolean; writes?: boolean; destructive?: boolean }): ToolEffect {
  if (!metadata?.trusted) return 'unknown';
  if (metadata.writes || metadata.destructive) return 'write';
  return metadata.readOnly === true ? 'read' : 'unknown';
}

function concurrency(value = 1): number {
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error('TOOL_CONCURRENCY_INVALID');
  return value;
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Request aborted');
}

/**
 * Read waves are bounded; a write/unknown is a global barrier. Results stay in model-call order.
 * Reclassifying any queued read drains the entire previous wave before invoking the upgraded call.
 * A rejected/unknown active dispatch is never implicitly retried.
 */
export async function scheduleToolBatch(calls: readonly RuntimeToolCall[], options: ToolSchedulerOptions): Promise<string[]> {
  const width = concurrency(options.readConcurrency);
  const outputs = new Array<string>(calls.length);
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) throw new Error('TOOL_BATCH_DUPLICATE_ID');
    ids.add(call.id);
  }
  let cursor = 0;
  while (cursor < calls.length) {
    active(options.signal);
    const wave: Array<{ index: number; call: RuntimeToolCall; classification: ToolClassification }> = [];
    const resources = new Set<string>();
    const servers = new Map<string, number>();
    while (cursor < calls.length && wave.length < width) {
      active(options.signal);
      const call = calls[cursor];
      const initial = options.classify(call);
      let checked = await options.recheck?.(call, initial) ?? initial;
      // Hooks cannot downgrade a conservative write/unknown to read.
      if (initial.effect !== 'read' && checked.effect === 'read') checked = { ...checked, effect: initial.effect };
      checked = { ...checked, resources: [...new Set([...initial.resources, ...checked.resources])],
        serverKey: initial.serverKey || checked.serverKey,
        serverConcurrency: Math.min(initial.serverConcurrency || 1, checked.serverConcurrency || 1) };
      const exclusive = checked.effect !== 'read';
      const conflict = checked.resources.some(key => resources.has(key))
        || (checked.serverKey && (servers.get(checked.serverKey) || 0) >= (checked.serverConcurrency || 1));
      if (wave.length && (exclusive || conflict)) break;
      wave.push({ index: cursor++, call, classification: checked });
      checked.resources.forEach(key => resources.add(key));
      if (checked.serverKey) servers.set(checked.serverKey, (servers.get(checked.serverKey) || 0) + 1);
      if (exclusive) break;
    }
    let failure: unknown;
    // All promises are observed and drained, even if one dispatch fails.
    const settled = await Promise.allSettled(wave.map(async item => {
      active(options.signal);
      await options.reserve?.(item.call, item.classification);
      active(options.signal);
      options.onDispatch?.(item.call, item.classification);
      outputs[item.index] = await options.execute(item.call, item.classification);
    }));
    for (const item of settled) if (item.status === 'rejected') failure ??= item.reason;
    if (failure) throw failure;
    active(options.signal);
  }
  return outputs;
}
