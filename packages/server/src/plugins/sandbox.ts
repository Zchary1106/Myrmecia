/**
 * Plugin execution boundary.
 *
 * Plugins are local, administrator-installed code. A Worker keeps execution
 * isolated from request state and gives the entry point no platform internals,
 * but it is not a security boundary for hostile JavaScript. Remote URLs are
 * deliberately rejected by the route that invokes this class.
 */

import { Worker } from 'worker_threads';
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { logger } from '../lib/logger.js';

export interface SandboxOptions {
  timeoutMs?: number;
  modulePath?: string;
  allowedRoot?: string;
}

export class PluginSandbox {
  private defaultTimeout: number;

  constructor(opts?: { defaultTimeoutMs?: number }) {
    this.defaultTimeout = opts?.defaultTimeoutMs ?? 30_000;
  }

  async execute(pluginId: string, method: string, args: unknown[] = [], opts?: SandboxOptions): Promise<unknown> {
    if (!opts?.modulePath || !opts.allowedRoot) {
      throw new Error(`Plugin ${pluginId} requires a trusted local module path`);
    }
    const root = realpathSync(resolve(opts.allowedRoot));
    const modulePath = realpathSync(resolve(opts.modulePath));
    if (relative(root, modulePath).startsWith('..')) {
      throw new Error(`Plugin ${pluginId} entry escapes its installed source root`);
    }
    const timeout = opts.timeoutMs ?? this.defaultTimeout;
    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { pathToFileURL } = require('node:url');
      parentPort.on('message', async (message) => {
        try {
          const plugin = await import(pathToFileURL(workerData.modulePath).href);
          const target = plugin[message.method] || plugin.default?.[message.method];
          if (typeof target !== 'function') throw new Error('Plugin method is not exported: ' + message.method);
          const value = await target(...message.args);
          parentPort.postMessage({ type: 'result', value });
        } catch (error) {
          parentPort.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    `;

    return new Promise((resolveResult, reject) => {
      const worker = new Worker(workerCode, { eval: true, workerData: { modulePath } });
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        callback();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`Plugin ${pluginId}.${method} timed out after ${timeout}ms`))), timeout);
      worker.on('message', (message: { type: 'result' | 'error'; value?: unknown; message?: string }) => {
        if (message.type === 'error') finish(() => reject(new Error(message.message || 'Plugin execution failed')));
        else finish(() => resolveResult(message.value));
      });
      worker.once('error', err => {
        logger.error({ err, pluginId, method }, 'Plugin worker error');
        finish(() => reject(err));
      });
      worker.once('exit', code => {
        if (code !== 0) finish(() => reject(new Error(`Plugin worker exited with code ${code}`)));
      });
      worker.postMessage({ method, args });
    });
  }
}

export const pluginSandbox = new PluginSandbox();
